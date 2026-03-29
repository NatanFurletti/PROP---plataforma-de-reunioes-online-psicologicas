import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../contexts/useSessionStore";

interface UseWebRTCOptions {
  sessionId: string;
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (error: Error) => void;
}

export const useWebRTC = ({
  sessionId,
  onRemoteStream,
  onError,
}: UseWebRTCOptions) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "idle" | "connecting" | "connected" | "failed"
  >("idle");

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Initialize media stream
  const initializeMedia = async () => {
    try {
      setConnectionState("connecting");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (error) {
      const err =
        error instanceof Error
          ? error
          : new Error("Failed to get media stream");
      onError?.(err);
      setConnectionState("failed");
      throw err;
    }
  };

  // Initialize WebRTC connection
  const initializePeerConnection = async (stream: MediaStream) => {
    try {
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          // Add TURN server if configured
          process.env.VITE_TURN_URL && {
            urls: process.env.VITE_TURN_URL,
            username: process.env.VITE_TURN_USERNAME,
            credential: process.env.VITE_TURN_CREDENTIAL,
          },
        ].filter(Boolean) as any,
      });

      // Add local stream
      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      // Handle remote stream
      peerConnection.ontrack = (event) => {
        const remoteStream = event.streams[0];
        setRemoteStream(remoteStream);
        onRemoteStream?.(remoteStream);
      };

      peerConnection.onconnectionstatechange = () => {
        switch (peerConnection.connectionState) {
          case "connected":
            setConnectionState("connected");
            break;
          case "failed":
            setConnectionState("failed");
            break;
        }
      };

      peerConnectionRef.current = peerConnection;
    } catch (error) {
      const err =
        error instanceof Error
          ? error
          : new Error("Failed to initialize peer connection");
      onError?.(err);
      throw err;
    }
  };

  // Toggle microphone
  const toggleMic = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicMuted(!audioTrack.enabled);
      }
    }
  };

  // Toggle camera
  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCameraOff(!videoTrack.enabled);
      }
    }
  };

  // End call and cleanup
  const endCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }
    setLocalStream(null);
    setRemoteStream(null);
    setConnectionState("idle");
  };

  useEffect(() => {
    return () => {
      endCall();
    };
  }, []);

  return {
    localStream,
    remoteStream,
    isMicMuted,
    isCameraOff,
    connectionState,
    initializeMedia,
    initializePeerConnection,
    toggleMic,
    toggleCamera,
    endCall,
    peerConnection: peerConnectionRef.current,
  };
};
