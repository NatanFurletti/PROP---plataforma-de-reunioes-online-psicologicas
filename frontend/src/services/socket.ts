import { io, Socket } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3333";

export interface SocketAuth {
  sessionId: string;
  role: "host" | "guest";
  // Necessário apenas para guest (host autentica via cookie JWT)
  accessToken?: string;
}

let socketInstance: Socket | null = null;
// Auth do socket ativo, para decidir entre reutilizar e recriar
let currentAuth: SocketAuth | null = null;

function sameAuth(a: SocketAuth | null, b: SocketAuth): boolean {
  return (
    a !== null &&
    a.sessionId === b.sessionId &&
    a.role === b.role &&
    a.accessToken === b.accessToken
  );
}

// Inicializa a conexão Socket.IO com o handshake de autenticação.
// Reutiliza o socket existente quando o `auth` é equivalente — chamadas
// repetidas (ex: a cada candidato ICE) nao podem derrubar a sinalizacao.
// Só recria quando o handshake muda de fato.
export const initializeSocket = (auth: SocketAuth): Socket => {
  if (socketInstance && sameAuth(currentAuth, auth)) {
    return socketInstance;
  }

  if (socketInstance) {
    socketInstance.close();
    socketInstance = null;
  }

  currentAuth = { ...auth };
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
  currentAuth = null;
};
