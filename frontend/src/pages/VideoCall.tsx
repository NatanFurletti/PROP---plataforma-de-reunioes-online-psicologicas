import React, { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChatPanel } from "../components/ChatPanel";
import { ControlButton } from "../components/ControlButton";
import { VideoTile } from "../components/VideoTile";
import { useChat } from "../hooks/useChat";
import { usePictureInPicture } from "../hooks/usePictureInPicture";
import { useWakeLock } from "../hooks/useWakeLock";
import { useWebRTC, type RemoteParticipant } from "../hooks/useWebRTC";
import { healthService } from "../services/api";
import {
  clearGuestIdentity,
  loadGuestIdentity,
  updateGuestIdentity,
} from "../utils/guestIdentity";

// Intervalo do ping que mantém o backend acordado (Render free dorme após
// ~15 min sem requisições HTTP; o WebSocket sozinho pode não contar)
const KEEP_ALIVE_MS = 4 * 60 * 1000;
const NOTICE_DURATION_MS = 6000;

// Mensagens amigáveis para erros conhecidos da sinalização/WebRTC
function friendlyError(error: Error): string {
  const message = error.message || "";
  // DOMException traz o tipo em `name` (ex.: NotReadableError)
  const detail = `${error.name} ${message}`;
  if (/another tab or device/i.test(message)) {
    return "Você entrou nesta sessão em outra aba ou dispositivo. Esta janela foi desconectada.";
  }
  if (/audio only/i.test(message)) {
    // `name` traz o motivo real da falha da câmera
    if (/NotAllowedError|SecurityError/.test(error.name)) {
      return "O navegador bloqueou a câmera. Você entrou só com áudio: libere a câmera no ícone de cadeado da barra de endereço e toque em Câmera.";
    }
    if (/NotFoundError|OverconstrainedError/.test(error.name)) {
      return "Nenhuma câmera foi encontrada. Você entrou só com áudio.";
    }
    return "Não foi possível usar a câmera (ela pode estar em uso por outro programa ou navegador). Você entrou só com áudio: feche o outro programa e toque em Câmera para ligá-la.";
  }
  if (/NotReadableError|Could not start video source|Failed to allocate videosource/i.test(detail)) {
    return "A câmera está em uso por outro programa ou navegador. Feche-o e toque em Câmera para tentar de novo.";
  }
  if (/Could not start audio source/i.test(detail)) {
    return "O microfone está em uso por outro programa. Feche-o e entre novamente.";
  }
  if (/NotFoundError|Requested device not found/i.test(detail)) {
    return "Nenhuma câmera ou microfone foi encontrado neste dispositivo.";
  }
  if (/Permission denied|NotAllowedError|media devices/i.test(detail)) {
    return "Não foi possível acessar câmera e microfone. Verifique as permissões do navegador.";
  }
  if (/no longer available/i.test(message)) {
    return "Esta sessão não está mais disponível.";
  }
  if (/Invalid access token|Session not found/i.test(message)) {
    return "Link de sessão inválido.";
  }
  if (/Invalid name/i.test(message)) {
    return "Nome inválido. Volte ao link da sessão e informe seu nome.";
  }
  if (/failed after 3 attempts/i.test(message)) {
    return "A conexão com um participante caiu e não foi possível restabelecê-la.";
  }
  return message || "Ocorreu um erro na videochamada.";
}

export const VideoCall: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();

  const rawRole = searchParams.get("role");

  // Validar role declarativamente — sem chamar navigate() durante render
  if (rawRole !== "host" && rawRole !== "guest") {
    return <Navigate to="/" replace />;
  }

  const role = rawRole as "host" | "guest";

  // Guest: nome, accessToken e chave vêm da identidade salva neste navegador
  const identity = role === "guest" && sessionId ? loadGuestIdentity(sessionId) : null;
  const patientName = identity?.name ?? null;
  const accessToken = identity?.accessToken;

  // Guest sem accessToken ou nome não pode entrar
  if (role === "guest" && (!accessToken || !patientName)) {
    return <Navigate to="/" replace />;
  }

  return (
    <VideoCallInner
      sessionId={sessionId!}
      role={role}
      patientName={patientName}
      accessToken={accessToken}
      admissionKey={identity?.admissionKey}
    />
  );
};

interface VideoCallInnerProps {
  sessionId: string;
  role: "host" | "guest";
  patientName: string | null;
  accessToken?: string;
  admissionKey?: string;
}

// Colunas da grade conforme o número de participantes remotos
function gridColumns(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count <= 4) return "grid-cols-1 sm:grid-cols-2";
  return "grid-cols-2 lg:grid-cols-3";
}

function participantLabel(p: RemoteParticipant): string {
  return p.role === "host" ? "Psicólogo" : p.name;
}

// Só mostra o vídeo quando ele está de fato chegando; caso contrário um
// avatar com o motivo substitui o quadro congelado
function participantStatus(p: RemoteParticipant): string | undefined {
  if (p.connectionState === "reconnecting") return "Reconectando...";
  if (p.connectionState === "failed") return "Sem conexão";
  if (p.connectionState !== "connected") return "Conectando...";
  if (!p.isVideoFlowing) return "Câmera pausada";
  return undefined;
}

const VideoCallInner: React.FC<VideoCallInnerProps> = ({
  sessionId,
  role,
  patientName,
  accessToken,
  admissionKey,
}) => {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showConfirmEnd, setShowConfirmEnd] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  // Aviso informativo (ex.: o psicólogo desligou seu microfone)
  const [notice, setNotice] = useState<string | null>(null);

  // Guarda a chave do paciente: voltar pelo link (nova aba, reload) não
  // pede o nome de novo nem, depois de aprovado, nova aprovação
  const saveAdmissionKey = useCallback(
    (key: string) => updateGuestIdentity(sessionId, { admissionKey: key }),
    [sessionId],
  );

  const handleSessionEnded = useCallback(() => {
    if (role === "guest") {
      // A sala acabou: a chave não vale mais
      clearGuestIdentity(sessionId);
      navigate("/session-ended", { replace: true });
    } else {
      navigate("/dashboard", { replace: true });
    }
  }, [navigate, role, sessionId]);

  const handleError = useCallback((error: Error) => {
    setErrorMessage(friendlyError(error));
  }, []);

  const handleForceMuted = useCallback(() => {
    setNotice("O psicólogo desligou seu microfone. Toque em Mic para religar.");
  }, []);

  const handleRoomFull = useCallback(() => {
    setErrorMessage(
      "A sala atingiu o limite de participantes. Tente novamente mais tarde.",
    );
  }, []);

  const {
    localStream,
    participants,
    waitingGuests,
    admissionStatus,
    isMicMuted,
    isCameraOff,
    connectionState,
    socket,
    toggleMic,
    toggleCamera,
    admitGuest,
    denyGuest,
    muteParticipant,
    endCall,
  } = useWebRTC({
    sessionId,
    role,
    accessToken,
    name: patientName ?? undefined,
    admissionKey,
    onAdmissionKey: saveAdmissionKey,
    onSessionEnded: handleSessionEnded,
    onRoomFull: handleRoomFull,
    onForceMuted: handleForceMuted,
    onError: handleError,
  });

  // O aviso some sozinho depois de alguns segundos
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useWakeLock(true);

  const {
    messages: chatMessages,
    unreadCount,
    sendMessage,
  } = useChat({
    socket,
    enabled: admissionStatus === "admitted",
    isOpen: isChatOpen,
    selfName: patientName ?? "Psicólogo",
    selfRole: role,
  });

  // Janela flutuante: mostra o psicólogo (para o paciente) ou o primeiro
  // participante com vídeo (para o psicólogo)
  const pipTarget =
    participants.find((p) => p.role === "host" && p.stream) ??
    participants.find((p) => p.stream);
  const [pipVideo, setPipVideo] = useState<HTMLVideoElement | null>(null);
  const {
    isSupported: pipSupported,
    isActive: pipActive,
    toggle: togglePipWindow,
  } = usePictureInPicture(pipTarget ? pipVideo : null);

  const togglePip = useCallback(() => {
    togglePipWindow().catch(() => {
      setErrorMessage("Não foi possível abrir a janela flutuante.");
    });
  }, [togglePipWindow]);

  useEffect(() => {
    const timer = setInterval(() => {
      healthService.ping().catch(() => {
        // Falha pontual não importa: o próximo ping tenta de novo
      });
    }, KEEP_ALIVE_MS);
    return () => clearInterval(timer);
  }, []);

  // Sair da chamada. O destino é definido aqui, sem depender de resposta
  // do servidor — o socket é fechado em seguida e nenhum evento chegaria.
  const leave = useCallback(() => {
    endCall();
    if (role === "host") {
      navigate("/dashboard", { replace: true });
    } else {
      navigate("/session-ended", { replace: true, state: { reason: "left" } });
    }
  }, [endCall, navigate, role]);

  const handleEndClick = () => {
    if (role === "host") {
      setShowConfirmEnd(true);
    } else {
      leave();
    }
  };

  const handleConfirmEnd = () => {
    setShowConfirmEnd(false);
    leave();
  };

  const connectionBadgeColor = {
    idle: "bg-gray-500",
    connecting: "bg-yellow-500",
    connected: "bg-green-500",
    reconnecting: "bg-orange-500",
    failed: "bg-red-500",
  }[connectionState];

  const waitingForOthersLabel =
    role === "host" ? "Aguardando participantes..." : "Conectando...";

  const connectionBadgeLabel = {
    idle: "Iniciando...",
    connecting: participants.length === 0 ? waitingForOthersLabel : "Conectando...",
    connected: "Conectado",
    reconnecting: "Reconectando...",
    failed: "Falha na conexão",
  }[connectionState];

  const localLabel =
    role === "host" ? "Você (Psicólogo)" : `Você (${patientName ?? "Paciente"})`;

  // ---- Paciente aguardando aprovação ou recusado ----
  if (role === "guest" && admissionStatus !== "admitted") {
    const denied = admissionStatus === "denied";
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="bg-gray-900 rounded-xl p-6 w-full max-w-md text-center shadow-2xl">
          <div className="w-full aspect-video rounded-lg overflow-hidden mb-5">
            <VideoTile stream={localStream} label={localLabel} isMuted={true} />
          </div>

          {errorMessage ? (
            <p role="alert" className="text-red-400 text-sm mb-4">
              {errorMessage}
            </p>
          ) : denied ? (
            <div role="status" className="mb-5">
              <h1 className="text-white text-lg font-semibold mb-1">
                Entrada não autorizada
              </h1>
              <p className="text-gray-400 text-sm">
                O psicólogo não autorizou sua entrada nesta sessão.
              </p>
            </div>
          ) : (
            <div role="status" aria-live="polite" className="mb-5">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <h1 className="text-white text-lg font-semibold mb-1">
                Aguardando aprovação
              </h1>
              <p className="text-gray-400 text-sm">
                O psicólogo foi avisado e vai liberar sua entrada em instantes.
              </p>
            </div>
          )}

          <button
            onClick={leave}
            className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors"
          >
            {denied ? "Fechar" : "Sair"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-950 flex flex-col relative">
      {/* Status da conexão */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-white ${connectionBadgeColor}`}
        >
          <span className="w-2 h-2 rounded-full bg-white opacity-80" />
          {connectionBadgeLabel}
        </span>
        <span className="px-3 py-1 rounded-full text-xs font-medium text-white bg-gray-700">
          {participants.length + 1} na chamada
        </span>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-red-700 text-white px-4 py-2 rounded-lg text-sm max-w-sm text-center"
        >
          {errorMessage}
          <button
            onClick={() => setErrorMessage(null)}
            className="ml-3 underline text-xs"
            aria-label="Fechar mensagem de erro"
          >
            fechar
          </button>
        </div>
      )}

      {notice && !errorMessage && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-gray-800 border border-gray-600 text-white px-4 py-2 rounded-lg text-sm max-w-sm text-center"
        >
          {notice}
          <button
            onClick={() => setNotice(null)}
            className="ml-3 underline text-xs"
            aria-label="Fechar aviso"
          >
            fechar
          </button>
        </div>
      )}

      {/* Pedidos de entrada (somente host) */}
      {role === "host" && waitingGuests.length > 0 && (
        <section
          aria-label="Pedidos para entrar na sessão"
          aria-live="polite"
          className="absolute top-14 right-4 z-50 w-80 max-w-[calc(100%-2rem)] space-y-2"
        >
          {waitingGuests.map((guest) => (
            <div
              key={guest.guestId}
              className="bg-white rounded-lg shadow-xl p-4"
            >
              <p className="text-xs text-gray-500 mb-1">Quer entrar na sessão</p>
              <p className="font-semibold text-gray-900 break-words mb-3">
                {guest.name}
              </p>
              {/* Mesmo nome de quem já está na chamada: provavelmente a
                  mesma pessoa em outro navegador ou dispositivo */}
              {participants.some(
                (p) =>
                  p.role === "guest" &&
                  p.name.trim().toLowerCase() === guest.name.trim().toLowerCase(),
              ) && (
                <p className="text-xs text-orange-600 -mt-2 mb-3">
                  Já há alguém com este nome na chamada.
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => denyGuest(guest.guestId)}
                  className="px-3 py-1.5 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm"
                  aria-label={`Recusar entrada de ${guest.name}`}
                >
                  Recusar
                </button>
                <button
                  onClick={() => admitGuest(guest.guestId)}
                  className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
                  aria-label={`Admitir ${guest.name}`}
                >
                  Admitir
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="flex-1 flex min-h-0">
      {/* Área de vídeo */}
      <div className="flex-1 relative overflow-hidden">
        {participants.length > 0 ? (
          <div
            className={`grid ${gridColumns(participants.length)} auto-rows-fr gap-2 p-2 h-full`}
          >
            {participants.map((p) => (
              <VideoTile
                key={p.peerId}
                stream={p.stream}
                label={participantLabel(p)}
                status={participantStatus(p)}
                showVideo={participantStatus(p) === undefined}
                isMuted={false}
                isMicMuted={p.isMicMuted}
                onMuteMic={
                  role === "host" ? () => muteParticipant(p.peerId) : undefined
                }
                videoRef={p.peerId === pipTarget?.peerId ? setPipVideo : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950 z-10">
            {connectionState !== "failed" && (
              <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
            )}
            <p className="text-gray-300 text-sm">{connectionBadgeLabel}</p>
          </div>
        )}

        {/* Vídeo local (picture-in-picture) */}
        <div className="absolute bottom-4 right-4 w-40 h-28 rounded-lg overflow-hidden shadow-lg border border-gray-700 z-20">
          <VideoTile
            stream={localStream}
            label={localLabel}
            isMuted={true}
            isMicMuted={isMicMuted}
          />
        </div>
      </div>

      {isChatOpen && (
        <ChatPanel
          messages={chatMessages}
          onSend={sendMessage}
          onClose={() => setIsChatOpen(false)}
        />
      )}
      </div>

      {/* Controles */}
      <div className="bg-gray-900 px-4 py-4 flex flex-wrap justify-center items-center gap-3">
        <ControlButton
          onClick={toggleMic}
          variant={isMicMuted ? "danger" : "secondary"}
        >
          {isMicMuted ? "🔇 Mic" : "🎙️ Mic"}
        </ControlButton>

        <ControlButton
          onClick={toggleCamera}
          variant={isCameraOff ? "danger" : "secondary"}
        >
          {isCameraOff ? "📷 Câmera" : "📹 Câmera"}
        </ControlButton>

        {pipSupported && (
          <ControlButton
            onClick={togglePip}
            variant={pipActive ? "primary" : "secondary"}
            ariaPressed={pipActive}
            ariaLabel={
              pipActive ? "Fechar janela flutuante" : "Abrir janela flutuante"
            }
          >
            🗗 Janela
          </ControlButton>
        )}

        <ControlButton
          onClick={() => setIsChatOpen((open) => !open)}
          variant={isChatOpen ? "primary" : "secondary"}
          ariaPressed={isChatOpen}
          ariaLabel={
            unreadCount > 0
              ? `Chat, ${unreadCount} ${unreadCount === 1 ? "mensagem nova" : "mensagens novas"}`
              : "Chat"
          }
        >
          💬 Chat
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </ControlButton>

        <ControlButton onClick={handleEndClick} variant="danger">
          {role === "host" ? "Encerrar" : "Sair"}
        </ControlButton>
      </div>

      {/* Confirmação de encerramento (host) */}
      {showConfirmEnd && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-end-title"
            className="bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
          >
            <h2 id="confirm-end-title" className="text-white text-lg font-semibold mb-2">
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
                autoFocus
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
