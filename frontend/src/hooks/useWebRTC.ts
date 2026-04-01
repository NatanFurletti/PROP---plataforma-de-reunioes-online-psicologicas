import { useCallback, useEffect, useRef, useState } from "react";
import { initializeSocket } from "../services/socket";

interface UseWebRTCOptions {
  sessionId: string;
  role: "host" | "guest";
  onSessionEnded?: () => void;
  onError?: (error: Error) => void;
}

interface UseWebRTCReturn {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMicMuted: boolean;
  isCameraOff: boolean;
  connectionState: "idle" | "connecting" | "connected" | "failed";
  toggleMic: () => void;
  toggleCamera: () => void;
  endCall: () => void;
}

export const useWebRTC = ({
  sessionId,
  role,
  onSessionEnded,
  onError,
}: UseWebRTCOptions): UseWebRTCReturn => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "idle" | "connecting" | "connected" | "failed"
  >("idle");

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const reconnectAttemptsRef = useRef(0);
  // Guardar referências estáveis para callbacks para evitar re-registros desnecessários
  const onSessionEndedRef = useRef(onSessionEnded);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onSessionEndedRef.current = onSessionEnded;
  }, [onSessionEnded]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Criar e configurar RTCPeerConnection
  const createPeerConnection = useCallback(
    (stream: MediaStream): RTCPeerConnection => {
      const iceServers: RTCIceServer[] = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ];

      const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
      if (turnUrl) {
        iceServers.push({
          urls: turnUrl,
          username: import.meta.env.VITE_TURN_USERNAME as string,
          credential: import.meta.env.VITE_TURN_CREDENTIAL as string,
        });
      }

      const pc = new RTCPeerConnection({ iceServers });

      // Adicionar tracks locais
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Receber stream remoto
      pc.ontrack = (event) => {
        setRemoteStream(event.streams[0]);
      };

      // Enviar candidatos ICE ao servidor de sinalização
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const socket = initializeSocket();
          socket.emit("ice-candidate", {
            sessionId,
            candidate: event.candidate,
          });
        }
      };

      // Monitorar estado da conexão e tentar reconectar se necessário
      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case "connecting":
            setConnectionState("connecting");
            break;
          case "connected":
            reconnectAttemptsRef.current = 0;
            setConnectionState("connected");
            break;
          case "failed":
            setConnectionState("failed");
            if (reconnectAttemptsRef.current < 3) {
              reconnectAttemptsRef.current++;
              setTimeout(() => {
                // Recriar peer connection e renegociar
                if (localStreamRef.current) {
                  const newPc = createPeerConnection(localStreamRef.current);
                  peerConnectionRef.current?.close();
                  peerConnectionRef.current = newPc;

                  if (role === "host") {
                    newPc
                      .createOffer()
                      .then((offer) => newPc.setLocalDescription(offer))
                      .then(() => {
                        const socket = initializeSocket();
                        socket.emit("offer", {
                          sessionId,
                          offer: newPc.localDescription,
                        });
                      })
                      .catch((err) => {
                        onErrorRef.current?.(
                          err instanceof Error ? err : new Error(String(err))
                        );
                      });
                  }
                }
              }, 3000);
            } else {
              onErrorRef.current?.(
                new Error("Connection failed after 3 attempts")
              );
            }
            break;
        }
      };

      return pc;
    },
    [sessionId, role]
  );

  // Encerrar chamada e limpar recursos
  const endCall = useCallback(() => {
    // Parar todos os tracks de mídia
    localStreamRef.current?.getTracks().forEach((t) => t.stop());

    // Fechar peer connection
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    // Emitir encerramento de sessão se for o host
    if (role === "host") {
      const socket = initializeSocket();
      socket.emit("session-end", { sessionId });
    }

    // Remover listeners do socket
    const socket = initializeSocket();
    socket.off("user-joined");
    socket.off("offer");
    socket.off("answer");
    socket.off("ice-candidate");
    socket.off("session-ended");

    // Resetar estados
    setLocalStream(null);
    setRemoteStream(null);
    localStreamRef.current = null;
    setConnectionState("idle");
  }, [sessionId, role]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      // 1. Solicitar permissão de câmera e microfone
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        if (cancelled) return;
        setConnectionState("failed");
        onErrorRef.current?.(
          err instanceof Error ? err : new Error("Failed to access media devices")
        );
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setConnectionState("connecting");

      // 2. Criar RTCPeerConnection e adicionar tracks
      const pc = createPeerConnection(stream);
      peerConnectionRef.current = pc;

      // 3. Inicializar socket e entrar na sala
      const socket = initializeSocket();
      socket.emit("join-room", { sessionId, role });

      // 4. Registrar listeners de sinalização

      // Host cria offer quando o guest entra
      socket.on("user-joined", async () => {
        if (cancelled) return;
        if (role === "host") {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("offer", { sessionId, offer: pc.localDescription });
          } catch (err) {
            onErrorRef.current?.(
              err instanceof Error ? err : new Error("Failed to create offer")
            );
          }
        }
      });

      // Guest recebe offer e responde com answer
      socket.on(
        "offer",
        async ({ offer }: { offer: RTCSessionDescriptionInit }) => {
          if (cancelled) return;
          if (role === "guest") {
            try {
              await pc.setRemoteDescription(offer);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.emit("answer", { sessionId, answer: pc.localDescription });
            } catch (err) {
              onErrorRef.current?.(
                err instanceof Error ? err : new Error("Failed to create answer")
              );
            }
          }
        }
      );

      // Host recebe answer do guest
      socket.on(
        "answer",
        async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
          if (cancelled) return;
          try {
            await pc.setRemoteDescription(answer);
          } catch (err) {
            onErrorRef.current?.(
              err instanceof Error
                ? err
                : new Error("Failed to set remote description")
            );
          }
        }
      );

      // Adicionar candidatos ICE recebidos
      socket.on(
        "ice-candidate",
        async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
          if (cancelled) return;
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            // Candidatos ICE podem falhar silenciosamente em alguns casos
            console.warn("Failed to add ICE candidate:", err);
          }
        }
      );

      // Sessão encerrada pelo host
      socket.on("session-ended", () => {
        if (cancelled) return;
        onSessionEndedRef.current?.();
      });
    };

    setup();

    // Cleanup ao desmontar
    return () => {
      cancelled = true;
      endCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, role]);

  // Alternar microfone
  const toggleMic = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicMuted(!audioTrack.enabled);
      }
    }
  }, []);

  // Alternar câmera
  const toggleCamera = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCameraOff(!videoTrack.enabled);
      }
    }
  }, []);

  return {
    localStream,
    remoteStream,
    isMicMuted,
    isCameraOff,
    connectionState,
    toggleMic,
    toggleCamera,
    endCall,
  };
};
