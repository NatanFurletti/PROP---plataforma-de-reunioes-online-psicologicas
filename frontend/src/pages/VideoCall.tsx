import React from "react";

export const VideoCall: React.FC = () => {
  return (
    <div className="h-screen bg-gray-950 flex flex-col">
      {/* Main video area */}
      <div className="flex-1 grid grid-cols-2 gap-4 p-4">
        {/* Local video */}
        <div className="rounded-lg bg-gray-900 flex items-center justify-center">
          <p className="text-gray-400">Sua câmera</p>
        </div>

        {/* Remote video */}
        <div className="rounded-lg bg-gray-900 flex items-center justify-center">
          <p className="text-gray-400">Câmera do paciente</p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-gray-900 p-6 flex justify-center gap-4">
        <button className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white">
          Microfone
        </button>
        <button className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white">
          Câmera
        </button>
        <button className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white">
          Encerrar
        </button>
      </div>
    </div>
  );
};
