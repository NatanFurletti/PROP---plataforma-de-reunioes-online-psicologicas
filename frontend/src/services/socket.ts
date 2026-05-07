import { io, Socket } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3333";

let socketInstance: Socket | null = null;

export interface SocketAuth {
  sessionId: string;
  role: "host" | "guest";
  // Necessário apenas para guest (host autentica via cookie JWT)
  accessToken?: string;
}

// Inicializa a conexão Socket.IO com o handshake de autenticação.
// Cada chamada com `auth` diferente fecha o socket anterior e cria um novo,
// para garantir que o servidor sempre receba os dados corretos no handshake.
export const initializeSocket = (auth: SocketAuth): Socket => {
  if (socketInstance) {
    socketInstance.close();
    socketInstance = null;
  }

  socketInstance = io(SOCKET_URL, {
    withCredentials: true,
    auth,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
  });

  socketInstance.on("connect", () => {
    if (import.meta.env.DEV) console.log("Socket connected:", socketInstance?.id);
  });
  socketInstance.on("disconnect", () => {
    if (import.meta.env.DEV) console.log("Socket disconnected");
  });

  return socketInstance;
};

export const getSocket = (): Socket => {
  if (!socketInstance) {
    throw new Error("Socket not initialized. Call initializeSocket first.");
  }
  return socketInstance;
};

export const closeSocket = (): void => {
  if (socketInstance) {
    socketInstance.close();
    socketInstance = null;
  }
};
