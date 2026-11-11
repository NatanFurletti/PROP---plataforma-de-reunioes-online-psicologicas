import React from "react";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  // Silencia a reprodução do <video> (ex.: vídeo local, para não ecoar)
  isMuted?: boolean;
  // O participante está com o microfone desligado: mostra o ícone de mudo
  isMicMuted?: boolean;
  // Host: botão para desligar o microfone deste participante
  onMuteMic?: () => void;
  // Participante com a mão levantada: mostra a mão no canto do vídeo
  isHandRaised?: boolean;
  // Posição na fila de mãos (1 = levantou primeiro). Só é passada quando
  // há mais de uma mão levantada.
  handOrder?: number;
  // Host: botão para abaixar a mão deste participante
  onLowerHand?: () => void;
  // false: cobre o vídeo com um avatar (ex.: par caiu e o quadro congelou).
  // O <video> continua montado por baixo, então o áudio segue tocando.
  showVideo?: boolean;
  // Texto mostrado sob o avatar (ex.: "Reconectando...")
  status?: string;
  // Expõe o <video> (ex.: para a janela flutuante)
  videoRef?: (element: HTMLVideoElement | null) => void;
}

export const VideoTile: React.FC<VideoTileProps> = ({
  stream,
  label,
  isMuted = false,
  isMicMuted = false,
  onMuteMic,
  isHandRaised = false,
  handOrder,
  onLowerHand,
  showVideo = true,
  status,
  videoRef,
}) => {
  const localRef = React.useRef<HTMLVideoElement | null>(null);

  const setRefs = React.useCallback(
    (element: HTMLVideoElement | null) => {
      localRef.current = element;
      videoRef?.(element);
    },
    [videoRef],
  );

  React.useEffect(() => {
    if (localRef.current && stream) {
      localRef.current.srcObject = stream;
    }
  }, [stream]);

  const initial = label.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative bg-gray-900 rounded-lg overflow-hidden h-full">
      <video
        ref={setRefs}
        autoPlay
        playsInline
        muted={isMuted}
        className="w-full h-full object-cover"
      />
      {!showVideo && (
        <div
          data-testid="video-placeholder"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-800"
        >
          <div
            aria-hidden="true"
            className="w-16 h-16 rounded-full bg-gray-600 flex items-center justify-center text-white text-2xl font-semibold"
          >
            {initial}
          </div>
          {status && (
            <p role="status" className="text-gray-300 text-sm">
              {status}
            </p>
          )}
        </div>
      )}
      <div className="absolute bottom-2 left-2 right-2 flex items-center gap-2 pointer-events-none">
        <div className="min-w-0 flex items-center gap-1.5 bg-black bg-opacity-60 px-3 py-1 rounded text-white text-sm">
          {isMicMuted && (
            <span
              role="img"
              aria-label="Microfone desligado"
              title="Microfone desligado"
              data-testid="mic-muted-icon"
              className="shrink-0 text-red-500"
            >
              <MicOffIcon />
            </span>
          )}
          <span className="truncate">{label}</span>
        </div>
      </div>
      {isHandRaised && (
        <div
          role="img"
          aria-label={
            handOrder
              ? `${label} levantou a mão (${handOrder}º da fila)`
              : `${label} levantou a mão`
          }
          title={handOrder ? `Mão levantada · ${handOrder}º` : "Mão levantada"}
          data-testid="hand-raised-icon"
          className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black bg-opacity-60 text-sm leading-none"
        >
          <span aria-hidden="true">✋</span>
          {handOrder !== undefined && (
            <span aria-hidden="true" className="text-[10px] font-medium text-gray-300">
              {handOrder}º
            </span>
          )}
        </div>
      )}
      {((onMuteMic && !isMicMuted) || (onLowerHand && isHandRaised)) && (
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {onMuteMic && !isMicMuted && (
            <button
              type="button"
              onClick={onMuteMic}
              aria-label={`Desligar o microfone de ${label}`}
              title="Desligar microfone"
              className={`${TILE_ACTION_CLASS} hover:bg-red-600 focus:bg-red-600`}
            >
              <MicOffIcon />
              Mutar
            </button>
          )}
          {onLowerHand && isHandRaised && (
            <button
              type="button"
              onClick={onLowerHand}
              aria-label={`Abaixar a mão de ${label}`}
              title="Abaixar a mão"
              className={`${TILE_ACTION_CLASS} hover:bg-gray-600 focus:bg-gray-600`}
            >
              <span aria-hidden="true">✋</span>
              Abaixar
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const TILE_ACTION_CLASS =
  "flex items-center gap-1 px-2 py-1 rounded bg-black bg-opacity-60 text-white text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white";

// Microfone cortado (ícone em linha, herda a cor do texto)
const MicOffIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);
