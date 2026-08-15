import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import cookie from "cookie";
import { AuthService } from "../services/index";
import { logger } from "../config/logger";

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

// Informações de um participante na sala
interface ParticipantInfo {
  socketId: string;
  role: "host" | "guest";
}

// Estado de uma sala de sinalização
interface RoomState {
  participants: Map<string, ParticipantInfo>; // key: socketId
  // Momento em que a sala ficou sem nenhum participante. null enquanto
  // houver alguém conectado.
  emptySince: number | null;
}

// Uma sala sem ninguém conectado por este tempo é encerrada e a sessão
// marcada como COMPLETED — evita sessões presas em IN_PROGRESS quando
// ambos os lados caem sem encerrar.
export const IDLE_ROOM_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

// Dados validados anexados ao socket.data após o handshake
interface SocketAuth {
  sessionId: string;
  role: "host" | "guest";
  // Para host: id do psicólogo dono da sessão. Para guest: indefinido.
  psychologistId?: string;
}

// Helper tipado: lê `auth` do socket.data preservando narrowing
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

// Retorna o socketId do outro participante da sala, se existir
function getOtherParticipant(
  room: RoomState,
  currentSocketId: string,
): string | undefined {
  for (const [socketId] of room.participants) {
    if (socketId !== currentSocketId) return socketId;
  }
  return undefined;
}

// Encontra a sala em que um socket está participando
function findRoomBySocket(socketId: string): [string, RoomState] | undefined {
  for (const [sessionId, room] of rooms) {
    if (room.participants.has(socketId)) {
      return [sessionId, room];
    }
  }
  return undefined;
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
      const sessionId = socket.handshake.auth?.sessionId as string | undefined;
      const role = socket.handshake.auth?.role as "host" | "guest" | undefined;
      const accessToken = socket.handshake.auth?.accessToken as
        | string
        | undefined;

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
        // Host autentica via cookie JWT do psicólogo dono da sessão
        const jwtToken = getJwtFromCookies(socket.handshake.headers.cookie);
        if (!jwtToken) {
          return next(new Error("Missing auth cookie"));
        }
        let decoded: { id: string; email: string };
        try {
          decoded = await AuthService.verifyTokenWithVersion(jwtToken);
        } catch {
          return next(new Error("Invalid auth token"));
        }
        if (decoded.id !== session.psychologistId) {
          return next(new Error("Forbidden: not the session owner"));
        }
        setAuth(socket, { sessionId, role, psychologistId: decoded.id });
      } else {
        // Guest autentica via accessToken da sessão
        if (!accessToken || accessToken !== session.accessToken) {
          return next(new Error("Invalid access token"));
        }
        setAuth(socket, { sessionId, role });
      }

      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error("Auth failed"));
    }
  });

  io.on("connection", (socket: Socket) => {
    // ----------------------------------------------------------------
    // join-room: participante entra na sala de sinalização
    // O sessionId/role são lidos do auth validado, não do payload.
    // ----------------------------------------------------------------
    socket.on("join-room", async () => {
      const auth = getAuth(socket);
      if (!auth) return;
      const { sessionId, role } = auth;

      // Verificar se a sala já tem 2 participantes
      const existing = rooms.get(sessionId);
      if (existing && existing.participants.size >= 2) {
        socket.emit("room-full", {
          error: "Room already has 2 participants",
        });
        return;
      }

      // Garantir unicidade por role: se já existe um host/guest, rejeitar duplicado
      if (existing) {
        for (const p of existing.participants.values()) {
          if (p.role === role) {
            socket.emit("room-full", {
              error: `A ${role} is already connected to this room`,
            });
            return;
          }
        }
      }

      // Criar sala se ainda não existir
      if (!existing) {
        rooms.set(sessionId, { participants: new Map(), emptySince: null });
      }

      const room = rooms.get(sessionId)!;

      // Adicionar socket à sala Socket.IO e ao Map interno
      socket.join(sessionId);
      room.participants.set(socket.id, { socketId: socket.id, role });
      room.emptySince = null;

      // Quando o host entra, marcar a sessão como IN_PROGRESS (idempotente)
      if (role === "host") {
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
      }

      // Notificar o outro participante (se já estiver na sala)
      const otherId = getOtherParticipant(room, socket.id);
      if (otherId) {
        io.to(otherId).emit("user-joined", { role });
      }
    });

    // ----------------------------------------------------------------
    // offer: encaminhar SDP offer para o outro participante
    // ----------------------------------------------------------------
    socket.on(
      "offer",
      (payload: { offer: RTCSessionDescriptionInit }) => {
        const auth = getAuth(socket);
        if (!auth) return;
        const room = rooms.get(auth.sessionId);
        if (!room) return;

        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("offer", { offer: payload.offer });
        }
      },
    );

    // ----------------------------------------------------------------
    // answer: encaminhar SDP answer para o outro participante
    // ----------------------------------------------------------------
    socket.on(
      "answer",
      (payload: { answer: RTCSessionDescriptionInit }) => {
        const auth = getAuth(socket);
        if (!auth) return;
        const room = rooms.get(auth.sessionId);
        if (!room) return;

        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("answer", { answer: payload.answer });
        }
      },
    );

    // ----------------------------------------------------------------
    // ice-candidate: encaminhar candidato ICE para o outro participante
    // ----------------------------------------------------------------
    socket.on(
      "ice-candidate",
      (payload: { candidate: RTCIceCandidateInit }) => {
        const auth = getAuth(socket);
        if (!auth) return;
        const room = rooms.get(auth.sessionId);
        if (!room) return;

        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("ice-candidate", { candidate: payload.candidate });
        }
      },
    );

    // ----------------------------------------------------------------
    // session-end: somente o host pode encerrar
    // ----------------------------------------------------------------
    socket.on("session-end", async () => {
      const auth = getAuth(socket);
      if (!auth) return;
      if (auth.role !== "host") return;

      const { sessionId } = auth;
      const room = rooms.get(sessionId);

      // Emitir session-ended para todos na sala (inclusive o remetente)
      io.to(sessionId).emit("session-ended");

      // Atualizar status da sessão para COMPLETED no banco de dados
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

      // Limpar a sala do Map
      if (room) {
        rooms.delete(sessionId);
      }
    });

    // ----------------------------------------------------------------
    // disconnect: participante desconectou
    // ----------------------------------------------------------------
    socket.on("disconnect", () => {
      const entry = findRoomBySocket(socket.id);
      if (!entry) return;

      const [, room] = entry;

      // Remover o socket desconectado do Map
      room.participants.delete(socket.id);

      // Notificar o participante restante
      const otherId = getOtherParticipant(room, socket.id);
      if (otherId) {
        io.to(otherId).emit("user-left");
      }

      // Sala vazia não é removida na hora: o participante pode estar
      // reconectando. O varredor de inatividade encerra depois do timeout.
      if (room.participants.size === 0) {
        room.emptySince = Date.now();
      }
    });
  });
}
