import React from "react";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  isMuted?: boolean;
}

export const VideoTile: React.FC<VideoTileProps> = ({
  stream,
  label,
  isMuted = false,
}) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="relative bg-gray-900 rounded-lg overflow-hidden h-full">
      <video
        ref={videoRef}
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
