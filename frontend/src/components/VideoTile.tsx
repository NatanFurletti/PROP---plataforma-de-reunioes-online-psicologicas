import React from "react";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  isMuted?: boolean;
  // Expõe o <video> (ex.: para a janela flutuante)
  videoRef?: (element: HTMLVideoElement | null) => void;
}

export const VideoTile: React.FC<VideoTileProps> = ({
  stream,
  label,
  isMuted = false,
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

  return (
    <div className="relative bg-gray-900 rounded-lg overflow-hidden h-full">
      <video
        ref={setRefs}
        autoPlay
        playsInline
        muted={isMuted}
        className="w-full h-full object-cover"
      />
      <div className="absolute bottom-2 left-2 bg-black bg-opacity-60 px-3 py-1 rounded text-white text-sm">
        {label}
      </div>
    </div>
  );
};
