import React from "react";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  isMuted?: boolean;
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
      <div className="absolute bottom-2 left-2 bg-black bg-opacity-60 px-3 py-1 rounded text-white text-sm">
        {label}
      </div>
    </div>
  );
};
