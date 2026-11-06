import { randomUUID } from "node:crypto";
import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import cookie from "cookie";
import { AuthService, SessionService } from "../services/index.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import { createChatRateLimiter, parseChatMessage } from "./chat.js";

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
  // Guest: chave do paciente (identifica a mesma pessoa entre conexões)
  admissionKey?: string;
  // Microfone desligado. Todos os participantes veem o ícone de mudo.
  micMuted: boolean;
  // Remoção agendada após uma queda involuntária (ver RECONNECT_GRACE_MS)
  removalTimer: NodeJS.Timeout | null;
}

// Paciente aguardando aprovação do psicólogo
interface WaitingGuest {
  socketId: string;
  name: string;
  admissionKey: string;
  // Estado do microfone informado no join-room, usado ao ser admitido
  micMuted: boolean;
}

// Paciente conhecido pela sala. A chave é entregue no primeiro pedido de
// entrada e fica guardada no navegador dele: ao voltar pelo mesmo link,
// ele é reconhecido, mantém o nome e, se já foi aprovado, entra direto.
interface KnownGuest {
  name: string;
  admitted: boolean;
}

// Estado de uma sala de sinalização
interface RoomState {
  participants: Map<string, ParticipantInfo>; // key: socketId
  waiting: Map<string, WaitingGuest>; // key: socketId
  // Pacientes que já pediram para entrar, por chave
  guests: Map<string, KnownGuest>;
  // Momento em que a sala ficou sem ninguém. null enquanto houver alguém.
  emptySince: number | null;
}

// Uma sala sem ninguém conectado por este tempo é encerrada e a sessão
// marcada como COMPLETED — evita sessões presas em IN_PROGRESS quando
// todos caem sem encerrar.
export const IDLE_ROOM_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

// Tolerância para quedas involuntárias do socket. No celular, trocar de
// app ou bloquear a tela congela a página e derruba o WebSocket, mas a
// mídia P2P pode continuar (ou voltar com um ICE restart). Durante essa
// janela o participante continua na sala e os outros não recebem
// `user-left`; se o socket voltar via connection state recovery (mesmo
// socket.id), a chamada segue sem renegociar.
export const RECONNECT_GRACE_MS = env.RECONNECT_GRACE_MS;

// Opções do Socket.IO que habilitam a recuperação de estado. O middleware
// de autenticação roda de novo na reconexão (skipMiddlewares: false).
export const CONNECTION_STATE_RECOVERY = {
  maxDisconnectionDuration: RECONNECT_GRACE_MS,
  skipMiddlewares: false,
};

// Motivos em que o socket saiu de propósito: remove da sala na hora
const INTENTIONAL_DISCONNECT_REASONS = new Set([
  "client namespace disconnect",
  "server namespace disconnect",
  "server shutting down",
]);

// Limite da sala (psicólogo incluso). A chamada é em malha P2P: cada
// participante envia sua mídia para todos os outros, então o custo de
// banda cresce rápido — acima de ~6 pessoas seria preciso um SFU.
export const MAX_ROOM_PARTICIPANTS = env.MAX_ROOM_PARTICIPANTS;
// Evita que um link vazado encha a lista de espera do psicólogo
const MAX_WAITING_GUESTS = 20;
// Pacientes diferentes que podem pedir entrada numa mesma sala
const MAX_KNOWN_GUESTS = 100;
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
  for (const room of rooms.values()) clearRemovalTimers(room);
  rooms.clear();
}

function clearRemovalTimers(room: RoomState): void {
  for (const p of room.participants.values()) {
    if (p.removalTimer) clearTimeout(p.removalTimer);
    p.removalTimer = null;
  }
}

function getOrCreateRoom(sessionId: string): RoomState {
  let room = rooms.get(sessionId);
  if (!room) {
    room = {
      participants: new Map(),
      waiting: new Map(),
      guests: new Map(),
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
        const providedKey =
          typeof handshake.admissionKey === "string"
            ? handshake.admissionKey
            : undefined;
        // Paciente já conhecido pela sala: o nome é o do primeiro pedido.
        // Assim a mesma pessoa não aparece com outro nome.
        const known = providedKey
          ? rooms.get(sessionId)?.guests.get(providedKey)
          : undefined;
        const name = known?.name ?? sanitizeName(handshake.name);
        if (!name) {
          return next(new Error("Invalid name"));
        }
        // Chave desconhecida (ex.: sala recriada após reinício do servidor)
        // é descartada: o paciente recebe uma nova ao pedir entrada
        const admissionKey = known ? providedKey : undefined;
        setAuth(socket, { sessionId, role, name, admissionKey });
      }

      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error("Auth failed"));
    }
  });

  // Tira um participante da sala e avisa os demais
  function removeParticipant(sessionId: string, room: RoomState, socketId: string): void {
    const participant = room.participants.get(socketId);
    if (!participant) return;
    if (participant.removalTimer) clearTimeout(participant.removalTimer);
    room.participants.delete(socketId);
    io.to(sessionId).emit("user-left", { peerId: socketId });

    // Sala vazia não é removida na hora: alguém pode estar reconectando.
    // O varredor de inatividade encerra depois do timeout.
    if (room.participants.size === 0 && room.waiting.size === 0) {
      room.emptySince = Date.now();
    }
  }

  // A mesma pessoa entrou com um socket novo: tira o antigo da sala e, se
  // ele ainda estiver vivo (outra aba), avisa e desconecta
  function replaceParticipant(sessionId: string, room: RoomState, socketId: string): void {
    removeParticipant(sessionId, room, socketId);
    const oldSocket = io.sockets.sockets.get(socketId);
    if (oldSocket) {
      oldSocket.emit("session-replaced");
      oldSocket.disconnect(true);
    }
  }

  // Coloca um socket como participante da chamada e dispara a negociação:
  // quem entra recebe a lista de quem já está (e cria as offers); os demais
  // recebem `user-joined` e aguardam a offer do recém-chegado.
  function admitToCall(
    socket: Socket,
    room: RoomState,
    auth: SocketAuth,
    micMuted: boolean,
  ): void {
    const { sessionId, role, name } = auth;

    const peers = [...room.participants.values()].map((p) => ({
      peerId: p.socketId,
      role: p.role,
      name: p.name,
      micMuted: p.micMuted,
    }));

    socket.join(sessionId);
    room.participants.set(socket.id, {
      socketId: socket.id,
      role,
      name,
      admissionKey: auth.admissionKey,
      micMuted,
      removalTimer: null,
    });
    room.emptySince = null;

    socket
      .to(sessionId)
      .emit("user-joined", { peerId: socket.id, role, name, micMuted });
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

  // Atualiza o estado do microfone e avisa os demais da sala (só se mudou)
  function setMicMuted(
    sessionId: string,
    participant: ParticipantInfo,
    muted: boolean,
  ): void {
    if (participant.micMuted === muted) return;
    participant.micMuted = muted;
    io.to(sessionId)
      .except(participant.socketId)
      .emit("peer-mic-state", { peerId: participant.socketId, muted });
  }

  // join-room pode trazer o estado atual do microfone de quem entra
  function readMicMuted(payload: unknown): boolean {
    return (payload as { micMuted?: unknown } | undefined)?.micMuted === true;
  }

  io.on("connection", (socket: Socket) => {
    // ----------------------------------------------------------------
    // join-room: participante entra na sala de sinalização.
    // sessionId/role vêm do auth validado, nunca do payload.
    // Host entra direto; guest vai para a lista de espera até o host
    // aprovar (exceto se já foi aprovado antes nesta sala).
    // ----------------------------------------------------------------
    socket.on("join-room", async (payload?: unknown) => {
      const auth = getAuth(socket);
      if (!auth) return;
      const { sessionId, role } = auth;
      const micMuted = readMicMuted(payload);

      const room = getOrCreateRoom(sessionId);

      // Socket recuperado dentro da tolerância (mesmo socket.id): segue na
      // chamada como estava, sem renegociar — só cancela a remoção.
      const existing = room.participants.get(socket.id);
      if (existing) {
        if (existing.removalTimer) clearTimeout(existing.removalTimer);
        existing.removalTimer = null;
        setMicMuted(sessionId, existing, micMuted);
        return;
      }
      if (room.waiting.has(socket.id)) return;

      // Socket recuperado depois que a tolerância expirou: a recuperação
      // devolve as rooms do Socket.IO, mas ele já não é participante.
      socket.leave(sessionId);

      if (role === "host") {
        // Só o dono da sessão autentica como host: se já há um host, é o
        // mesmo psicólogo voltando (ex.: celular saiu do segundo plano
        // antes de o servidor notar a queda) ou em outra aba. O mais novo
        // assume a vaga.
        const currentHost = findHost(room);
        if (currentHost) replaceParticipant(sessionId, room, currentHost.socketId);

        admitToCall(socket, room, auth, micMuted);

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

      const known = auth.admissionKey ? room.guests.get(auth.admissionKey) : undefined;

      // Guest já aprovado antes (reload, queda, nova aba, voltou pelo
      // link): volta direto para a chamada
      if (auth.admissionKey && known?.admitted) {
        // Mesmo paciente voltando com outro socket: libera a vaga antiga,
        // mesmo que o servidor ainda não tenha notado a queda dela
        for (const p of [...room.participants.values()]) {
          if (p.admissionKey === auth.admissionKey) {
            replaceParticipant(sessionId, room, p.socketId);
          }
        }
        if (isRoomFull(room)) {
          socket.emit("room-full", { error: "Room is full" });
          return;
        }
        admitToCall(socket, room, auth, micMuted);
        return;
      }

      // Mesmo paciente pedindo de novo (outra aba, reload na espera): o
      // pedido novo substitui o antigo, sem duplicar na lista do psicólogo
      let replacedWaiting = false;
      if (auth.admissionKey && known) {
        for (const w of [...room.waiting.values()]) {
          if (w.admissionKey !== auth.admissionKey) continue;
          room.waiting.delete(w.socketId);
          replacedWaiting = true;
          const oldSocket = io.sockets.sockets.get(w.socketId);
          if (oldSocket) {
            oldSocket.emit("session-replaced");
            oldSocket.disconnect(true);
          }
        }
      }

      if (room.waiting.size >= MAX_WAITING_GUESTS) {
        socket.emit("room-full", { error: "Waiting list is full" });
        if (replacedWaiting) emitWaitingList(room);
        return;
      }

      // Primeiro pedido deste paciente: cria a chave que o identifica
      if (!auth.admissionKey || !known) {
        // Limita pacientes conhecidos para um link vazado não crescer o Map
        if (room.guests.size >= MAX_KNOWN_GUESTS) {
          socket.emit("room-full", { error: "Waiting list is full" });
          return;
        }
        auth.admissionKey = randomUUID();
        room.guests.set(auth.admissionKey, { name: auth.name, admitted: false });
      }

      room.waiting.set(socket.id, {
        socketId: socket.id,
        name: auth.name,
        admissionKey: auth.admissionKey,
        micMuted,
      });
      room.emptySince = null;
      socket.emit("waiting-for-approval", { admissionKey: auth.admissionKey });

      if (replacedWaiting) {
        emitWaitingList(room);
      } else {
        const host = findHost(room);
        if (host) {
          io.to(host.socketId).emit("guest-waiting", {
            guestId: socket.id,
            name: auth.name,
          });
        }
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

      const admissionKey = waiting.admissionKey;
      const known = room.guests.get(admissionKey);
      if (known) known.admitted = true;
      guestAuth.admissionKey = admissionKey;
      guestSocket.emit("admitted", { admissionKey });
      admitToCall(guestSocket, room, guestAuth, waiting.micMuted);
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
    function relay(
      event: "offer" | "answer" | "ice-candidate" | "restart-ice",
      data: object,
      to: unknown,
    ) {
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

    // restart-ice: quem não criou a offer pede ao outro lado um ICE
    // restart (ex.: voltou do segundo plano com a conexão P2P caída)
    socket.on("restart-ice", (payload: { to?: unknown }) => {
      relay("restart-ice", {}, payload?.to);
    });

    // ----------------------------------------------------------------
    // mic-state: o participante ligou/desligou o próprio microfone.
    // mute-participant: o host desliga o microfone de outro participante.
    // Só o próprio participante religa o microfone (não há "desmutar
    // alguém"): o servidor apenas marca como mudo e avisa o alvo, que
    // desliga o áudio no próprio navegador.
    // ----------------------------------------------------------------
    socket.on("mic-state", (payload: { muted?: unknown }) => {
      const auth = getAuth(socket);
      if (!auth) return;
      const room = rooms.get(auth.sessionId);
      const participant = room?.participants.get(socket.id);
      if (!participant || typeof payload?.muted !== "boolean") return;
      setMicMuted(auth.sessionId, participant, payload.muted);
    });

    socket.on("mute-participant", (payload: { peerId?: unknown }) => {
      const auth = getAuth(socket);
      if (!auth || auth.role !== "host") return;
      const room = rooms.get(auth.sessionId);
      if (!room || !room.participants.has(socket.id)) return;

      const peerId = typeof payload?.peerId === "string" ? payload.peerId : "";
      const target = room.participants.get(peerId);
      if (!target || target.socketId === socket.id) return;

      io.to(target.socketId).emit("force-muted");
      setMicMuted(auth.sessionId, target, true);
    });

    // ----------------------------------------------------------------
    // chat-message: texto e/ou arquivo para todos da chamada. Só quem foi
    // admitido envia e recebe. Nada é gravado — o servidor apenas repassa
    // (e não registra o conteúdo em log).
    // ----------------------------------------------------------------
    const allowChatMessage = createChatRateLimiter();

    socket.on("chat-message", (payload: unknown, ack?: unknown) => {
      const reply = (response: object) => {
        if (typeof ack === "function") ack(response);
      };
      const auth = getAuth(socket);
      if (!auth) return reply({ ok: false, error: "not-in-call" });
      const room = rooms.get(auth.sessionId);
      if (!room || !room.participants.has(socket.id)) {
        return reply({ ok: false, error: "not-in-call" });
      }

      const parsed = parseChatMessage(payload);
      if (typeof parsed === "string") return reply({ ok: false, error: parsed });
      if (!allowChatMessage(parsed.file?.size ?? 0)) {
        return reply({ ok: false, error: "rate-limited" });
      }

      const message = {
        id: randomUUID(),
        from: socket.id,
        senderName: auth.name,
        senderRole: auth.role,
        sentAt: new Date().toISOString(),
        ...(parsed.text ? { text: parsed.text } : {}),
        ...(parsed.file ? { file: parsed.file } : {}),
      };
      socket.to(auth.sessionId).emit("chat-message", message);
      reply({ ok: true, id: message.id, sentAt: message.sentAt });
    });

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
        clearRemovalTimers(room);
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
    socket.on("disconnect", (reason: string) => {
      const auth = getAuth(socket);
      if (!auth) return;
      const { sessionId } = auth;
      const room = rooms.get(sessionId);
      if (!room) return;

      if (room.waiting.delete(socket.id)) {
        emitWaitingList(room);
      }

      const participant = room.participants.get(socket.id);
      if (participant) {
        if (INTENTIONAL_DISCONNECT_REASONS.has(reason)) {
          removeParticipant(sessionId, room, socket.id);
          return;
        }
        // Queda involuntária (app em segundo plano, troca de rede):
        // mantém a vaga até a tolerância expirar
        if (participant.removalTimer) clearTimeout(participant.removalTimer);
        participant.removalTimer = setTimeout(() => {
          participant.removalTimer = null;
          if (rooms.get(sessionId) === room) {
            removeParticipant(sessionId, room, socket.id);
          }
        }, RECONNECT_GRACE_MS);
        participant.removalTimer.unref?.();
        return;
      }

      // Sala vazia não é removida na hora: alguém pode estar reconectando.
      // O varredor de inatividade encerra depois do timeout.
      if (room.participants.size === 0 && room.waiting.size === 0) {
        room.emptySince = Date.now();
      }
    });
  });
}
