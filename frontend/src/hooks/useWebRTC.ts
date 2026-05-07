import { useCallback, useEffect, useRef, useState } from "react";
import { initializeSocket, closeSocket } from "../services/socket";

interface UseWebRTCOptions {
  sessionId: string;
  role: "host" | "guest";
  // Necessário apenas para guest (host autentica via cookie JWT)
  accessToken?: string;
  onSessionEnded?: () => void;
  onRoomFull?: () => void;
  onError?: (error: Error) => void;
}

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

interface UseWebRTCReturn {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMicMuted: boolean;
  isCameraOff: boolean;
  connectionState: ConnectionState;
  toggleMic: () => void;
  toggleCamera: () => void;
  endCall: () => void;
}

export const useWebRTC = ({
  sessionId,
  role,
  accessToken,
  onSessionEnded,
  onRoomFull,
  onError,
}: UseWebRTCOptions): UseWebRTCReturn => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const reconnectAttemptsRef = useRef(0);
  // Buffer de candidatos ICE recebidos antes de setRemoteDescription
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  // Flag para saber se já podemos aplicar candidatos ICE diretamente
  const remoteDescriptionSetRef = useRef(false);

  // Guardar referências estáveis para callbacks para evitar re-registros
  const onSessionEndedRef = useRef(onSessionEnded);
  const onRoomFullRef = useRef(onRoomFull);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onSessionEndedRef.current = onSessionEnded;
  }, [onSessionEnded]);
  useEffect(() => {
    onRoomFullRef.current = onRoomFull;
  }, [onRoomFull]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Aplica candidatos ICE bufferizados após setRemoteDescription
  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const pending = pendingIceCandidatesRef.current;
    pendingIceCandidatesRef.current = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("Failed to add buffered ICE candidate:", err);
      }
    }
  }, []);

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
          // Tentar usar socket existente; ignorar se não inicializado ainda
          try {
            const socket = initializeSocket({ sessionId, role, accessToken });
            // initializeSocket recria caso auth tenha mudado; aqui só queremos pegar o atual
            socket.emit("ice-candidate", { candidate: event.candidate });
          } catch {
            // socket pode não estar pronto — candidato perdido é tolerável
          }
        }
      };

      // ICE restart leve: tentado quando a conexão "tropeça" mas o PC ainda existe.
      // Apenas o host reinicia ICE — o servidor entrega a nova offer ao guest.
      const tryIceRestart = async () => {
        if (role !== "host") return;
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          const socket = initializeSocket({ sessionId, role, accessToken });
          socket.emit("offer", { offer: pc.localDescription });
        } catch (err) {
          onErrorRef.current?.(
            err instanceof Error ? err : new Error("ICE restart failed"),
          );
        }
      };

      // Reconstrução completa: usado quando ICE restart não resolveu.
      const rebuildPeerConnection = () => {
        if (!localStreamRef.current) return;
        const newPc = createPeerConnection(localStreamRef.current);
        peerConnectionRef.current?.close();
        peerConnectionRef.current = newPc;
        remoteDescriptionSetRef.current = false;
        pendingIceCandidatesRef.current = [];
        // Reentrar na sala — servidor reemitirá user-joined
        const socket = initializeSocket({ sessionId, role, accessToken });
        socket.emit("join-room");
      };

      // Estado ICE: detecta quebras transitórias antes de connectionState
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "disconnected") {
          // Pode se recuperar sozinho — apenas sinalizar reconnecting
          setConnectionState("reconnecting");
        }
      };

      // Monitorar estado de conexão e aplicar estratégia em camadas
      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case "connecting":
            setConnectionState("connecting");
            break;
          case "connected":
            reconnectAttemptsRef.current = 0;
            setConnectionState("connected");
            break;
          case "disconnected":
            setConnectionState("reconnecting");
            break;
          case "failed": {
            const attempt = reconnectAttemptsRef.current;
            if (attempt >= 3) {
              setConnectionState("failed");
              onErrorRef.current?.(
                new Error("Connection failed after 3 attempts"),
              );
              return;
            }
            reconnectAttemptsRef.current = attempt + 1;
            setConnectionState("reconnecting");
            // Backoff exponencial: 1s, 2s, 4s
            const delayMs = 1000 * Math.pow(2, attempt);
            setTimeout(() => {
              // Primeira tentativa: ICE restart (mantém PC e tracks)
              // Tentativas seguintes: reconstrução completa
              if (attempt === 0) {
                void tryIceRestart();
              } else {
                rebuildPeerConnection();
              }
            }, delayMs);
            break;
          }
          case "closed":
            setConnectionState("idle");
            break;
        }
      };

      return pc;
    },
    [sessionId, role, accessToken],
  );

  // Encerrar chamada e limpar recursos
  const endCall = useCallback(() => {
    // Parar todos os tracks de mídia
    localStreamRef.current?.getTracks().forEach((t) => t.stop());

    // Fechar peer connection
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    // Emitir encerramento de sessão se for o host (servidor revalida o role)
    if (role === "host") {
      try {
        const socket = initializeSocket({ sessionId, role, accessToken });
        socket.emit("session-end");
      } catch {
        // socket pode já estar fechado
      }
    }

    // Fechar conexão socket por completo
    closeSocket();

    // Resetar estados
    setLocalStream(null);
    setRemoteStream(null);
    localStreamRef.current = null;
    remoteDescriptionSetRef.current = false;
    pendingIceCandidatesRef.current = [];
    setConnectionState("idle");
  }, [sessionId, role, accessToken]);

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
          err instanceof Error ? err : new Error("Failed to access media devices"),
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

      // 3. Inicializar socket com o handshake autenticado
      const socket = initializeSocket({ sessionId, role, accessToken });

      socket.on("connect_error", (err: Error) => {
        if (cancelled) return;
        onErrorRef.current?.(err);
      });

      // Após conectar, entrar na sala
      socket.on("connect", () => {
        socket.emit("join-room");
      });
      // Caso a conexão já esteja estabelecida (reuso ou rápido), garantir o emit
      if (socket.connected) socket.emit("join-room");

      // Sala cheia
      socket.on("room-full", () => {
        if (cancelled) return;
        onRoomFullRef.current?.();
      });

      // Host cria offer quando o guest entra
      socket.on("user-joined", async () => {
        if (cancelled) return;
        if (role === "host") {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("offer", { offer: pc.localDescription });
          } catch (err) {
            onErrorRef.current?.(
              err instanceof Error ? err : new Error("Failed to create offer"),
            );
          }
        }
      });

      // Guest recebe offer e responde com answer
      socket.on(
        "offer",
        async ({ offer }: { offer: RTCSessionDescriptionInit }) => {
          if (cancelled) return;
          if (role !== "guest") return;
          try {
            await pc.setRemoteDescription(offer);
            remoteDescriptionSetRef.current = true;
            await flushPendingCandidates(pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit("answer", { answer: pc.localDescription });
          } catch (err) {
            onErrorRef.current?.(
              err instanceof Error ? err : new Error("Failed to create answer"),
            );
          }
        },
      );

      // Host recebe answer do guest
      socket.on(
        "answer",
        async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
          if (cancelled) return;
          try {
            await pc.setRemoteDescription(answer);
            remoteDescriptionSetRef.current = true;
            await flushPendingCandidates(pc);
          } catch (err) {
            onErrorRef.current?.(
              err instanceof Error
                ? err
                : new Error("Failed to set remote description"),
            );
          }
        },
      );

      // Adicionar candidatos ICE recebidos — bufferizar se ainda não houver remoteDescription
      socket.on(
        "ice-candidate",
        async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
          if (cancelled) return;
          if (!remoteDescriptionSetRef.current) {
            pendingIceCandidatesRef.current.push(candidate);
            return;
          }
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.warn("Failed to add ICE candidate:", err);
          }
        },
      );

      // Sessão encerrada pelo host
      socket.on("session-ended", () => {
        if (cancelled) return;
        onSessionEndedRef.current?.();
      });

      // Outro participante saiu (ex: queda) — apenas atualiza UI
      socket.on("user-left", () => {
        if (cancelled) return;
        setRemoteStream(null);
      });
    };

    setup();

    // Cleanup ao desmontar
    return () => {
      cancelled = true;
      endCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, role, accessToken]);

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
