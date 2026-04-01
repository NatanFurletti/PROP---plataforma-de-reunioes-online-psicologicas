import React, { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ControlButton } from "../components/ControlButton";
import { VideoTile } from "../components/VideoTile";
import { useWebRTC } from "../hooks/useWebRTC";

export const VideoCall: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const rawRole = searchParams.get("role");

  // Validar role — redirecionar para / se inválido
  if (rawRole !== "host" && rawRole !== "guest") {
    navigate("/", { replace: true });
    return null;
  }

  const role = rawRole as "host" | "guest";

  // Para guest, ler patientName do sessionStorage
  const patientName =
    role === "guest"
      ? (() => {
          try {
            const raw = sessionStorage.getItem("patientSession");
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { patientName?: string };
            return parsed.patientName ?? null;
          } catch {
            return null;
          }
        })()
      : null;

  return (
    <VideoCallInner
      sessionId={sessionId!}
      role={role}
      patientName={patientName}
    />
  );
};

interface VideoCallInnerProps {
  sessionId: string;
  role: "host" | "guest";
  patientName: string | null;
}

const VideoCallInner: React.FC<VideoCallInnerProps> = ({
  sessionId,
  role,
  patientName,
}) => {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showConfirmEnd, setShowConfirmEnd] = useState(false);

  const handleSessionEnded = () => {
    if (role === "guest") {
      navigate("/session-ended");
    } else {
      navigate("/dashboard");
    }
  };

  const handleError = (error: Error) => {
    setErrorMessage(error.message || "Ocorreu um erro na videochamada.");
  };

  const {
    localStream,
    remoteStream,
    isMicMuted,
    isCameraOff,
    connectionState,
    toggleMic,
    toggleCamera,
    endCall,
  } = useWebRTC({
    sessionId,
    role,
    onSessionEnded: handleSessionEnded,
    onError: handleError,
  });

  const remoteLabel = role === "host" ? "Paciente" : "Psicólogo";

  const handleEndClick = () => {
    if (role === "host") {
      setShowConfirmEnd(true);
    } else {
      endCall();
    }
  };

  const handleConfirmEnd = () => {
    setShowConfirmEnd(false);
    endCall();
  };

  const connectionBadgeColor = {
    idle: "bg-gray-500",
    connecting: "bg-yellow-500",
    connected: "bg-green-500",
    failed: "bg-red-500",
  }[connectionState];

  const connectionBadgeLabel = {
    idle: "Aguardando",
    connecting: "Conectando...",
    connected: "Conectado",
    failed: "Falha na conexão",
  }[connectionState];

  return (
    <div className="h-screen bg-gray-950 flex flex-col relative">
      {/* Connection status badge */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-white ${connectionBadgeColor}`}
        >
          <span className="w-2 h-2 rounded-full bg-white opacity-80" />
          {connectionBadgeLabel}
        </span>
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-red-700 text-white px-4 py-2 rounded-lg text-sm max-w-sm text-center">
          {errorMessage}
        </div>
      )}

      {/* Main video area — remote video takes most of the screen */}
      <div className="flex-1 relative overflow-hidden">
        {/* Remote video (main) */}
        <div className="w-full h-full">
          <VideoTile stream={remoteStream} label={remoteLabel} isMuted={false} />
        </div>

        {/* Loading overlay while not connected */}
        {connectionState !== "connected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950 bg-opacity-80 z-10">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-gray-300 text-sm">{connectionBadgeLabel}</p>
          </div>
        )}

        {/* Local video (picture-in-picture, bottom-right) */}
        <div className="absolute bottom-4 right-4 w-40 h-28 rounded-lg overflow-hidden shadow-lg border border-gray-700 z-10">
          <VideoTile
            stream={localStream}
            label={role === "host" ? "Você (Psicólogo)" : `Você (${patientName ?? "Paciente"})`}
            isMuted={true}
          />
        </div>
      </div>

      {/* Controls bar */}
      <div className="bg-gray-900 px-6 py-4 flex justify-center items-center gap-4">
        {/* Mic button */}
        <ControlButton
          onClick={toggleMic}
          variant={isMicMuted ? "danger" : "secondary"}
        >
          {isMicMuted ? "🔇 Mic" : "🎙️ Mic"}
        </ControlButton>

        {/* Camera button */}
        <ControlButton
          onClick={toggleCamera}
          variant={isCameraOff ? "danger" : "secondary"}
        >
          {isCameraOff ? "📷 Câmera" : "📹 Câmera"}
        </ControlButton>

        {/* End call button */}
        <ControlButton onClick={handleEndClick} variant="danger">
          Encerrar
        </ControlButton>
      </div>

      {/* Confirmation dialog (host only) */}
      {showConfirmEnd && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h2 className="text-white text-lg font-semibold mb-2">
              Confirmar encerramento?
            </h2>
            <p className="text-gray-400 text-sm mb-6">
              A sessão será encerrada para todos os participantes.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowConfirmEnd(false)}
                className="px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirmEnd}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
              >
                Encerrar sessão
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
