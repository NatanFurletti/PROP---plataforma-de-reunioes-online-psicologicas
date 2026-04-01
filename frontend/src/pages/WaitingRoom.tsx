import React, { useEffect } from "react";
import { initializeSocket } from "../services/socket";

interface WaitingRoomProps {
  sessionId: string;
  onPsychologistJoined: () => void;
}

export const WaitingRoom: React.FC<WaitingRoomProps> = ({ sessionId, onPsychologistJoined }) => {
  useEffect(() => {
    const socket = initializeSocket();

    socket.emit("join-room", { sessionId, role: "guest" });

    const handleUserJoined = () => {
      onPsychologistJoined();
    };

    socket.on("user-joined", handleUserJoined);

    return () => {
      // Remove apenas o listener — não fecha o socket, pois será reutilizado na videochamada
      socket.off("user-joined", handleUserJoined);
    };
  }, [sessionId, onPsychologistJoined]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold mb-4">PsiConnect</h1>

        <div className="flex justify-center mb-6">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" aria-label="Carregando" />
        </div>

        <p className="text-gray-700 font-medium mb-2">Aguardando o psicólogo...</p>
        <p className="text-gray-500 text-sm">
          A sessão começará assim que o psicólogo entrar na sala.
        </p>
      </div>
    </div>
  );
};
