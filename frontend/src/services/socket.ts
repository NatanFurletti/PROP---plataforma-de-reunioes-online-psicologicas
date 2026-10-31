import { io, Socket } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3333";

export interface SocketAuth {
  sessionId: string;
  role: "host" | "guest";
  // Necessário apenas para guest (host autentica via token de socket ou cookie)
  accessToken?: string;
  // Guest: nome exibido ao psicólogo na tela de aprovação
  name?: string;
  // Guest: chave recebida ao ser aprovado, para voltar sem nova aprovação
  admissionKey?: string;
}

export interface SocketOptions extends SocketAuth {
  // Host: busca um token curto de socket a cada tentativa de conexão.
  // O cookie de login não chega ao backend quando ele está em outro domínio.
  getHostToken?: () => Promise<string>;
}

let socketInstance: Socket | null = null;
// Auth do socket ativo, para decidir entre reutilizar e recriar
let currentAuth: SocketAuth | null = null;
// Campos acrescentados depois da criação (ex.: admissionKey)
let authPatch: Partial<SocketAuth> = {};

function sameAuth(a: SocketAuth | null, b: SocketAuth): boolean {
  return (
    a !== null &&
    a.sessionId === b.sessionId &&
    a.role === b.role &&
    a.accessToken === b.accessToken &&
    a.name === b.name
  );
}

// Inicializa a conexão Socket.IO com o handshake de autenticação.
// Reutiliza o socket existente quando o `auth` é equivalente; só recria
// quando o handshake muda de fato.
export const initializeSocket = ({
  getHostToken,
  ...auth
}: SocketOptions): Socket => {
  if (socketInstance && sameAuth(currentAuth, auth)) {
    return socketInstance;
  }

  if (socketInstance) {
    socketInstance.close();
    socketInstance = null;
  }

  currentAuth = { ...auth };
  authPatch = {};

  // `auth` como função: é avaliada a cada (re)conexão, então reconexões
  // levam um token novo e os campos acrescentados com updateSocketAuth.
  const buildAuth = (cb: (data: object) => void) => {
    const base = { ...currentAuth, ...authPatch };
    if (!getHostToken) {
      cb(base);
      return;
    }
    getHostToken()
      .then((hostToken) => cb({ ...base, hostToken }))
      // Sem token, tenta pelo cookie (mesmo domínio, ex.: desenvolvimento)
      .catch(() => cb(base));
  };

  socketInstance = io(SOCKET_URL, {
    withCredentials: true,
    auth: buildAuth,
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

// Acrescenta campos ao handshake das próximas (re)conexões
export const updateSocketAuth = (patch: Partial<SocketAuth>): void => {
  authPatch = { ...authPatch, ...patch };
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
  authPatch = {};
};
