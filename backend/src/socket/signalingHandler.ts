import { randomUUID } from "node:crypto";
import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import cookie from "cookie";
import { AuthService, SessionService } from "../services/index.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";

// Subconjunto dos tipos WebRTC necessários para sinalização (não disponíveis no Node.js)
interface RTCSessionDescriptionInit {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

type Role = "host" | "guest";

// Participante admitido na chamada
interface ParticipantInfo {
  socketId: string;
  role: Role;
  name: string;
}

// Paciente aguardando aprovação do psicólogo
interface WaitingGuest {
  socketId: string;
  name: string;
}

// Estado de uma sala de sinalização
interface RoomState {
  participants: Map<string, ParticipantInfo>; // key: socketId
  waiting: Map<string, WaitingGuest>; // key: socketId
  // Chaves entregues a pacientes já aprovados. Permitem voltar à sala
  // (reload da página, queda de rede) sem nova aprovação.
  admittedKeys: Set<string>;
  // Momento em que a sala ficou sem ninguém. null enquanto houver alguém.
  emptySince: number | null;
}

// Uma sala sem ninguém conectado por este tempo é encerrada e a sessão
// marcada como COMPLETED — evita sessões presas em IN_PROGRESS quando
// todos caem sem encerrar.
export const IDLE_ROOM_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

// Limite da sala (psicólogo incluso). A chamada é em malha P2P: cada
// participante envia sua mídia para todos os outros, então o custo de
// banda cresce rápido — acima de ~6 pessoas seria preciso um SFU.
export const MAX_ROOM_PARTICIPANTS = env.MAX_ROOM_PARTICIPANTS;
// Evita que um link vazado encha a lista de espera do psicólogo
const MAX_WAITING_GUESTS = 20;
const MAX_NAME_LENGTH = 60;

// Dados validados anexados ao socket.data após o handshake
interface SocketAuth {
  sessionId: string;
  role: Role;
  name: string;
  // Para host: id do psicólogo dono da sessão
  psychologistId?: string;
  // Para guest: chave de reentrada recebida ao ser aprovado
  admissionKey?: string;
}

function getAuth(socket: Socket): SocketAuth | undefined {
  return (socket.data as { auth?: SocketAuth }).auth;
}

function setAuth(socket: Socket, auth: SocketAuth): void {
  (socket.data as { auth?: SocketAuth }).auth = auth;
}

// Mapa global de salas ativas: sessionId → RoomState.
//
// LIMITAÇÃO: estado em memória do processo. O backend só pode rodar em
// uma instância — com duas, os pares de uma sessão podem cair em
// processos diferentes e nunca trocar sinalização. Para escalar
// horizontalmente é preciso o adapter Redis do Socket.IO
// (@socket.io/redis-adapter) e mover este Map para o Redis.
const rooms = new Map<string, RoomState>();

// Estado global entre testes — sem isso um caso contamina o seguinte.
export function __resetRooms(): void {
  rooms.clear();
}

function getOrCreateRoom(sessionId: string): RoomState {
  let room = rooms.get(sessionId);
  if (!room) {
    room = {
      participants: new Map(),
      waiting: new Map(),
      admittedKeys: new Set(),
      emptySince: null,
    };
    rooms.set(sessionId, room);
  }
  return room;
}

function findHost(room: RoomState): ParticipantInfo | undefined {
  for (const p of room.participants.values()) {
    if (p.role === "host") return p;
  }
  return undefined;
}

// Remove caracteres de controle e limita o tamanho do nome exibido
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0 || cleaned.length > MAX_NAME_LENGTH) return null;
  return cleaned;
}

// Extrai cookie 'jwt' do header de cookies do handshake
function getJwtFromCookies(rawCookieHeader: string | undefined): string | null {
  if (!rawCookieHeader) return null;
  try {
    const parsed = cookie.parse(rawCookieHeader);
    return parsed.jwt ?? null;
  } catch {
    return null;
  }
}

// Encerra salas abandonadas: marca a sessão como COMPLETED e libera o Map.
// Exportada para permitir teste determinístico, sem esperar o intervalo.
export async function sweepIdleRooms(
  prisma: PrismaClient,
  now: number = Date.now(),
): Promise<string[]> {
  const swept: string[] = [];

  for (const [sessionId, room] of rooms) {
    if (
      room.participants.size === 0 &&
      room.waiting.size === 0 &&
      room.emptySince !== null &&
      now - room.emptySince >= IDLE_ROOM_TIMEOUT_MS
    ) {
      rooms.delete(sessionId);
      swept.push(sessionId);

      try {
        // updateMany: só encerra se ainda estiver em andamento
        await prisma.session.updateMany({
          where: { id: sessionId, status: "IN_PROGRESS" },
          data: { status: "COMPLETED", endedAt: new Date() },
        });
      } catch (err) {
        logger.error(
          { err, sessionId },
          "[signaling] Failed to complete idle session",
        );
      }
    }
  }

  return swept;
}

export function registerSignalingHandlers(
  io: Server,
  prisma: PrismaClient,
): void {
  // Varredura periódica de salas abandonadas. unref() para não segurar o
  // processo aberto quando não houver mais nada rodando.
  const sweeper = setInterval(() => {
    void sweepIdleRooms(prisma);
  }, IDLE_SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  io.on("close", () => clearInterval(sweeper));

  // Middleware de autenticação: valida sessionId/role/credenciais antes do `connection`
  io.use(async (socket, next) => {
    try {
      const handshake = socket.handshake.auth ?? {};
      const sessionId = handshake.sessionId as string | undefined;
      const role = handshake.role as Role | undefined;
      const accessToken = handshake.accessToken as string | undefined;

      if (!sessionId || (role !== "host" && role !== "guest")) {
        return next(new Error("Invalid handshake: sessionId/role required"));
      }

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
      });
      if (!session) {
        return next(new Error("Session not found"));
      }

      if (session.status === "COMPLETED" || session.status === "CANCELLED") {
        return next(new Error("Session no longer available"));
      }

      if (role === "host") {
        // Host autentica com o token curto de socket (frontend e backend em
        // domínios diferentes) ou, no mesmo domínio, com o cookie de login.
        let psychologistId: string;
        if (typeof handshake.hostToken === "string") {
          try {
            psychologistId = await SessionService.verifyHostSocketToken(
              handshake.hostToken,
              sessionId,
            );
          } catch {
            return next(new Error("Invalid auth token"));
          }
        } else {
          const jwtToken = getJwtFromCookies(socket.handshake.headers.cookie);
          if (!jwtToken) {
            return next(new Error("Missing auth cookie"));
          }
          try {
            psychologistId = (await AuthService.verifyTokenWithVersion(jwtToken)).id;
          } catch {
            return next(new Error("Invalid auth token"));
          }
        }
        if (psychologistId !== session.psychologistId) {
          return next(new Error("Forbidden: not the session owner"));
        }
        setAuth(socket, {
          sessionId,
          role,
          name: "Psicólogo",
          psychologistId,
        });
      } else {
        // Guest autentica via accessToken da sessão e precisa se identificar
        if (!accessToken || accessToken !== session.accessToken) {
          return next(new Error("Invalid access token"));
        }
        const name = sanitizeName(handshake.name);
        if (!name) {
          return next(new Error("Invalid name"));
        }
        const admissionKey =
          typeof handshake.admissionKey === "string"
            ? handshake.admissionKey
            : undefined;
        setAuth(socket, { sessionId, role, name, admissionKey });
      }

      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error("Auth failed"));
    }
  });

  // Coloca um socket como participante da chamada e dispara a negociação:
  // quem entra recebe a lista de quem já está (e cria as offers); os demais
  // recebem `user-joined` e aguardam a offer do recém-chegado.
  function admitToCall(socket: Socket, room: RoomState, auth: SocketAuth): void {
    const { sessionId, role, name } = auth;

    const peers = [...room.participants.values()].map((p) => ({
      peerId: p.socketId,
      role: p.role,
      name: p.name,
    }));

    socket.join(sessionId);
    room.participants.set(socket.id, { socketId: socket.id, role, name });
    room.emptySince = null;

    socket.to(sessionId).emit("user-joined", { peerId: socket.id, role, name });
    socket.emit("room-peers", { peers });
  }

  // Envia ao host a lista atual de pacientes aguardando aprovação
  function emitWaitingList(room: RoomState): void {
    const host = findHost(room);
    if (!host) return;
    io.to(host.socketId).emit("waiting-list", {
      guests: [...room.waiting.values()].map((g) => ({
        guestId: g.socketId,
        name: g.name,
      })),
    });
  }

  function isRoomFull(room: RoomState): boolean {
    return room.participants.size >= MAX_ROOM_PARTICIPANTS;
  }

  io.on("connection", (socket: Socket) => {
    // ----------------------------------------------------------------
    // join-room: participante entra na sala de sinalização.
    // sessionId/role vêm do auth validado, nunca do payload.
    // Host entra direto; guest vai para a lista de espera até o host
    // aprovar (exceto se já foi aprovado antes nesta sala).
    // ----------------------------------------------------------------
    socket.on("join-room", async () => {
      const auth = getAuth(socket);
      if (!auth) return;
      const { sessionId, role } = auth;

      const room = getOrCreateRoom(sessionId);

      // Evita entrar duas vezes com o mesmo socket
      if (room.participants.has(socket.id) || room.waiting.has(socket.id)) {
        return;
      }

      if (role === "host") {
        if (findHost(room)) {
          socket.emit("room-full", {
            error: "A host is already connected to this room",
          });
          return;
        }

        admitToCall(socket, room, auth);

        // Marcar a sessão como IN_PROGRESS (idempotente)
        try {
          await prisma.session.updateMany({
            where: { id: sessionId, status: "SCHEDULED" },
            data: { status: "IN_PROGRESS", startedAt: new Date() },
          });
        } catch (err) {
          logger.error(
            { err, sessionId },
            "[signaling] Failed to mark session IN_PROGRESS",
          );
        }

        // Pacientes que chegaram antes aparecem para aprovação
        emitWaitingList(room);
        return;
      }

      // Guest já aprovado antes (reload/queda): volta direto para a chamada
      if (auth.admissionKey && room.admittedKeys.has(auth.admissionKey)) {
        if (isRoomFull(room)) {
          socket.emit("room-full", { error: "Room is full" });
          return;
        }
        admitToCall(socket, room, auth);
        return;
      }

      if (room.waiting.size >= MAX_WAITING_GUESTS) {
        socket.emit("room-full", { error: "Waiting list is full" });
        return;
      }

      room.waiting.set(socket.id, { socketId: socket.id, name: auth.name });
      room.emptySince = null;
      socket.emit("waiting-for-approval");

      const host = findHost(room);
      if (host) {
        io.to(host.socketId).emit("guest-waiting", {
          guestId: socket.id,
          name: auth.name,
        });
      }
    });

    // ----------------------------------------------------------------
    // admit-guest / deny-guest: apenas o host decide quem entra
    // ----------------------------------------------------------------
    socket.on("admit-guest", (payload: { guestId?: unknown }) => {
      const auth = getAuth(socket);
      if (!auth || auth.role !== "host") return;
      const room = rooms.get(auth.sessionId);
      if (!room || !room.participants.has(socket.id)) return;

      const guestId = typeof payload?.guestId === "string" ? payload.guestId : "";
      const waiting = room.waiting.get(guestId);
      if (!waiting) return;

      if (isRoomFull(room)) {
        socket.emit("admission-error", {
          guestId,
          error: "Room is full",
        });
        return;
      }

      const guestSocket = io.sockets.sockets.get(guestId);
      const guestAuth = guestSocket ? getAuth(guestSocket) : undefined;
      room.waiting.delete(guestId);
      if (!guestSocket || !guestAuth) {
        emitWaitingList(room);
        return;
      }

      const admissionKey = randomUUID();
      room.admittedKeys.add(admissionKey);
      guestAuth.admissionKey = admissionKey;
      guestSocket.emit("admitted", { admissionKey });
      admitToCall(guestSocket, room, guestAuth);
      emitWaitingList(room);
    });

    socket.on("deny-guest", (payload: { guestId?: unknown }) => {
      const auth = getAuth(socket);
      if (!auth || auth.role !== "host") return;
      const room = rooms.get(auth.sessionId);
      if (!room || !room.participants.has(socket.id)) return;

      const guestId = typeof payload?.guestId === "string" ? payload.guestId : "";
      if (!room.waiting.delete(guestId)) return;

      io.to(guestId).emit("admission-denied");
      emitWaitingList(room);
    });

    // ----------------------------------------------------------------
    // offer / answer / ice-candidate: encaminhados a um par específico.
    // Só circulam entre participantes admitidos da mesma sala.
    // ----------------------------------------------------------------
    function relay(event: "offer" | "answer" | "ice-candidate", data: object, to: unknown) {
      const auth = getAuth(socket);
      if (!auth) return;
      const room = rooms.get(auth.sessionId);
      if (!room || !room.participants.has(socket.id)) return;
      if (typeof to !== "string" || to === socket.id) return;
      if (!room.participants.has(to)) return;
      io.to(to).emit(event, { from: socket.id, ...data });
    }

    socket.on(
      "offer",
      (payload: { to?: unknown; offer: RTCSessionDescriptionInit }) => {
        relay("offer", { offer: payload?.offer }, payload?.to);
      },
    );

    socket.on(
      "answer",
      (payload: { to?: unknown; answer: RTCSessionDescriptionInit }) => {
        relay("answer", { answer: payload?.answer }, payload?.to);
      },
    );

    socket.on(
      "ice-candidate",
      (payload: { to?: unknown; candidate: RTCIceCandidateInit }) => {
        relay("ice-candidate", { candidate: payload?.candidate }, payload?.to);
      },
    );

    // ----------------------------------------------------------------
    // session-end: somente o host pode encerrar
    // ----------------------------------------------------------------
    socket.on("session-end", async (ack?: unknown) => {
      const auth = getAuth(socket);
      if (!auth) return;
      if (auth.role !== "host") return;

      const { sessionId } = auth;
      const room = rooms.get(sessionId);

      // Avisar todos: participantes da chamada e quem ainda aguardava
      io.to(sessionId).emit("session-ended");
      if (room) {
        for (const guestId of room.waiting.keys()) {
          io.to(guestId).emit("session-ended");
        }
        rooms.delete(sessionId);
      }

      try {
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "COMPLETED", endedAt: new Date() },
        });
      } catch (err) {
        logger.error(
          { err, sessionId },
          "[signaling] Failed to update session status to COMPLETED",
        );
      }

      if (typeof ack === "function") ack();
    });

    // ----------------------------------------------------------------
    // disconnect: participante ou paciente em espera desconectou
    // ----------------------------------------------------------------
    socket.on("disconnect", () => {
      const auth = getAuth(socket);
      if (!auth) return;
      const room = rooms.get(auth.sessionId);
      if (!room) return;

      if (room.waiting.delete(socket.id)) {
        emitWaitingList(room);
      }

      if (room.participants.delete(socket.id)) {
        io.to(auth.sessionId).emit("user-left", { peerId: socket.id });
      }

      // Sala vazia não é removida na hora: alguém pode estar reconectando.
      // O varredor de inatividade encerra depois do timeout.
      if (room.participants.size === 0 && room.waiting.size === 0) {
        room.emptySince = Date.now();
      }
    });
  });
}
