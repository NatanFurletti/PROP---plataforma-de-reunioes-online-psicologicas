import { io, Socket } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3333";

let socketInstance: Socket | null = null;

export const initializeSocket = () => {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    socketInstance.on("connect", () => {
      console.log("Socket connected:", socketInstance?.id);
    });

    socketInstance.on("disconnect", () => {
      console.log("Socket disconnected");
    });
  }

  return socketInstance;
};

export const getSocket = () => {
  if (!socketInstance) {
    throw new Error("Socket not initialized. Call initializeSocket first.");
  }
  return socketInstance;
};

export const closeSocket = () => {
  if (socketInstance) {
    socketInstance.close();
    socketInstance = null;
  }
};
