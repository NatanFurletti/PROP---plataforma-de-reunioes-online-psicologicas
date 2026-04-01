import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";

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
}

// Mapa global de salas ativas: sessionId → RoomState
const rooms = new Map<string, RoomState>();

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

export function registerSignalingHandlers(
  io: Server,
  prisma: PrismaClient,
): void {
  io.on("connection", (socket: Socket) => {
    // ----------------------------------------------------------------
    // join-room: participante entra na sala de sinalização
    // ----------------------------------------------------------------
    socket.on(
      "join-room",
      (payload: { sessionId: string; role: "host" | "guest" }) => {
        const { sessionId, role } = payload;

        // Verificar se a sala já tem 2 participantes
        const existing = rooms.get(sessionId);
        if (existing && existing.participants.size >= 2) {
          socket.emit("room-full", {
            error: "Room already has 2 participants",
          });
          return;
        }

        // Criar sala se ainda não existir
        if (!existing) {
          rooms.set(sessionId, { participants: new Map() });
        }

        const room = rooms.get(sessionId)!;

        // Adicionar socket à sala Socket.IO e ao Map interno
        socket.join(sessionId);
        room.participants.set(socket.id, { socketId: socket.id, role });

        // Notificar o outro participante (se já estiver na sala)
        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("user-joined", { role });
        }
      },
    );

    // ----------------------------------------------------------------
    // offer: encaminhar SDP offer para o outro participante
    // ----------------------------------------------------------------
    socket.on(
      "offer",
      (payload: { sessionId: string; offer: RTCSessionDescriptionInit }) => {
        const { sessionId, offer } = payload;
        const room = rooms.get(sessionId);
        if (!room) return;

        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("offer", { offer });
        }
      },
    );

    // ----------------------------------------------------------------
    // answer: encaminhar SDP answer para o outro participante
    // ----------------------------------------------------------------
    socket.on(
      "answer",
      (payload: { sessionId: string; answer: RTCSessionDescriptionInit }) => {
        const { sessionId, answer } = payload;
        const room = rooms.get(sessionId);
        if (!room) return;

        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("answer", { answer });
        }
      },
    );

    // ----------------------------------------------------------------
    // ice-candidate: encaminhar candidato ICE para o outro participante
    // ----------------------------------------------------------------
    socket.on(
      "ice-candidate",
      (payload: { sessionId: string; candidate: RTCIceCandidateInit }) => {
        const { sessionId, candidate } = payload;
        const room = rooms.get(sessionId);
        if (!room) return;

        const otherId = getOtherParticipant(room, socket.id);
        if (otherId) {
          io.to(otherId).emit("ice-candidate", { candidate });
        }
      },
    );

    // ----------------------------------------------------------------
    // session-end: psicólogo encerra a sessão
    // ----------------------------------------------------------------
    socket.on("session-end", async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const room = rooms.get(sessionId);

      // Emitir session-ended para todos na sala (inclusive o remetente)
      io.to(sessionId).emit("session-ended");

      // Atualizar status da sessão para COMPLETED no banco de dados
      try {
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "COMPLETED" },
        });
      } catch {
        // Sessão pode não existir no banco — logar apenas em dev
        if (process.env.NODE_ENV !== "production") {
          console.error(
            `[signaling] Falha ao atualizar status da sessão ${sessionId}`,
          );
        }
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

      const [sessionId, room] = entry;

      // Remover o socket desconectado do Map
      room.participants.delete(socket.id);

      // Notificar o participante restante
      const otherId = getOtherParticipant(room, socket.id);
      if (otherId) {
        io.to(otherId).emit("user-left");
      }

      // Se a sala ficou vazia, remover do Map
      if (room.participants.size === 0) {
        rooms.delete(sessionId);
      }
    });
  });
}
