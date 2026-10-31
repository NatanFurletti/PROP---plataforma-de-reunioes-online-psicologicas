import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { initializeSocket, closeSocket } from "../services/socket";

export type Role = "host" | "guest";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

// pending: ainda sem resposta do servidor; waiting: na sala de espera;
// admitted: na chamada; denied: o psicólogo recusou a entrada.
export type AdmissionStatus = "pending" | "waiting" | "admitted" | "denied";

export interface RemoteParticipant {
  peerId: string;
  role: Role;
  name: string;
  stream: MediaStream | null;
  connectionState: ConnectionState;
}

export interface WaitingGuest {
  guestId: string;
  name: string;
}

interface UseWebRTCOptions {
  sessionId: string;
  role: Role;
  // Guest: token do link da sessão (host autentica via cookie JWT)
  accessToken?: string;
  // Guest: nome mostrado ao psicólogo para aprovação
  name?: string;
  // Guest: chave de reentrada de uma aprovação anterior
  admissionKey?: string;
  onAdmitted?: (admissionKey: string) => void;
  onAdmissionDenied?: () => void;
  onSessionEnded?: () => void;
  onRoomFull?: () => void;
  onError?: (error: Error) => void;
}

interface UseWebRTCReturn {
  localStream: MediaStream | null;
  participants: RemoteParticipant[];
  waitingGuests: WaitingGuest[];
  admissionStatus: AdmissionStatus;
  isMicMuted: boolean;
  isCameraOff: boolean;
  connectionState: ConnectionState;
  toggleMic: () => void;
  toggleCamera: () => void;
  admitGuest: (guestId: string) => void;
  denyGuest: (guestId: string) => void;
  endCall: () => void;
}

// Uma RTCPeerConnection por participante remoto (malha P2P)
interface PeerEntry {
  pc: RTCPeerConnection;
  // Candidatos ICE recebidos antes de setRemoteDescription
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  // Quem criou a offer é quem reinicia o ICE em caso de falha
  isOfferer: boolean;
  reconnectAttempts: number;
}

const MAX_RECONNECT_ATTEMPTS = 3;

function buildIceServers(): RTCIceServer[] {
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
  return iceServers;
}

function toError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(fallback);
}

export const useWebRTC = ({
  sessionId,
  role,
  accessToken,
  name,
  admissionKey,
  onAdmitted,
  onAdmissionDenied,
  onSessionEnded,
  onRoomFull,
  onError,
}: UseWebRTCOptions): UseWebRTCReturn => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [waitingGuests, setWaitingGuests] = useState<WaitingGuest[]>([]);
  const [admissionStatus, setAdmissionStatus] = useState<AdmissionStatus>(
    role === "host" ? "admitted" : "pending",
  );
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  // Estado da mídia local; o estado da chamada é derivado dos participantes
  const [mediaState, setMediaState] = useState<"idle" | "ready" | "failed">(
    "idle",
  );

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, PeerEntry>());
  const admissionKeyRef = useRef(admissionKey);

  // Referências estáveis para callbacks, evitando re-registro de handlers
  const callbacksRef = useRef({
    onAdmitted,
    onAdmissionDenied,
    onSessionEnded,
    onRoomFull,
    onError,
  });
  useEffect(() => {
    callbacksRef.current = {
      onAdmitted,
      onAdmissionDenied,
      onSessionEnded,
      onRoomFull,
      onError,
    };
  }, [onAdmitted, onAdmissionDenied, onSessionEnded, onRoomFull, onError]);

  const reportError = useCallback((err: unknown, fallback: string) => {
    callbacksRef.current.onError?.(toError(err, fallback));
  }, []);

  // Insere ou atualiza os dados de um participante remoto
  const upsertParticipant = useCallback(
    (peerId: string, patch: Partial<RemoteParticipant>) => {
      setParticipants((prev) => {
        const index = prev.findIndex((p) => p.peerId === peerId);
        if (index === -1) {
          return [
            ...prev,
            {
              peerId,
              role: "guest",
              name: "Participante",
              stream: null,
              connectionState: "connecting",
              ...patch,
            },
          ];
        }
        const next = [...prev];
        next[index] = { ...next[index], ...patch };
        return next;
      });
    },
    [],
  );

  const closePeer = useCallback((peerId: string) => {
    peersRef.current.get(peerId)?.pc.close();
    peersRef.current.delete(peerId);
    setParticipants((prev) => prev.filter((p) => p.peerId !== peerId));
  }, []);

  const closeAllPeers = useCallback(() => {
    for (const entry of peersRef.current.values()) entry.pc.close();
    peersRef.current.clear();
    setParticipants([]);
  }, []);

  const sendOffer = useCallback(
    async (peerId: string, iceRestart = false) => {
      const entry = peersRef.current.get(peerId);
      const socket = socketRef.current;
      if (!entry || !socket) return;
      try {
        const offer = await entry.pc.createOffer(
          iceRestart ? { iceRestart: true } : undefined,
        );
        await entry.pc.setLocalDescription(offer);
        socket.emit("offer", { to: peerId, offer: entry.pc.localDescription });
      } catch (err) {
        reportError(err, "Failed to create offer");
      }
    },
    [reportError],
  );

  const flushPendingCandidates = useCallback(async (entry: PeerEntry) => {
    const pending = entry.pendingCandidates;
    entry.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("Failed to add buffered ICE candidate:", err);
      }
    }
  }, []);

  // Cria a RTCPeerConnection de um par remoto
  const createPeer = useCallback(
    (peerId: string, isOfferer: boolean): PeerEntry => {
      const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
      const entry: PeerEntry = {
        pc,
        pendingCandidates: [],
        remoteDescriptionSet: false,
        isOfferer,
        reconnectAttempts: 0,
      };
      peersRef.current.set(peerId, entry);

      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        upsertParticipant(peerId, { stream: event.streams[0] ?? null });
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit("ice-candidate", {
            to: peerId,
            candidate: event.candidate,
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "disconnected") {
          upsertParticipant(peerId, { connectionState: "reconnecting" });
        }
      };

      pc.onconnectionstatechange = () => {
        // Conexão já descartada (par saiu ou foi substituído)
        if (peersRef.current.get(peerId) !== entry) return;

        switch (pc.connectionState) {
          case "connecting":
            upsertParticipant(peerId, { connectionState: "connecting" });
            break;
          case "connected":
            entry.reconnectAttempts = 0;
            upsertParticipant(peerId, { connectionState: "connected" });
            break;
          case "disconnected":
            upsertParticipant(peerId, { connectionState: "reconnecting" });
            break;
          case "failed": {
            const attempt = entry.reconnectAttempts;
            if (attempt >= MAX_RECONNECT_ATTEMPTS) {
              upsertParticipant(peerId, { connectionState: "failed" });
              reportError(null, "Connection failed after 3 attempts");
              return;
            }
            entry.reconnectAttempts = attempt + 1;
            upsertParticipant(peerId, { connectionState: "reconnecting" });
            // Só quem criou a offer reinicia o ICE; o outro lado responde.
            // Backoff exponencial: 1s, 2s, 4s.
            if (entry.isOfferer) {
              setTimeout(() => {
                if (peersRef.current.get(peerId) === entry) {
                  void sendOffer(peerId, true);
                }
              }, 1000 * Math.pow(2, attempt));
            }
            break;
          }
        }
      };

      return entry;
    },
    [upsertParticipant, reportError, sendOffer],
  );

  // Encerrar chamada e liberar recursos. Para o host, encerra a sessão
  // para todos; para o paciente, apenas sai.
  const endCall = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;

    for (const entry of peersRef.current.values()) entry.pc.close();
    peersRef.current.clear();

    if (role === "host") {
      // O servidor revalida o role. O Socket.IO envia o que está no buffer
      // antes de fechar, então o close logo em seguida não perde o evento.
      socketRef.current?.emit("session-end");
    }
    socketRef.current = null;
    closeSocket();

    setLocalStream(null);
    setParticipants([]);
    setWaitingGuests([]);
    setMediaState("idle");
  }, [role]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      // 1. Câmera e microfone
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        if (cancelled) return;
        setMediaState("failed");
        reportError(err, "Failed to access media devices");
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setMediaState("ready");

      // 2. Sinalização autenticada
      const socket = initializeSocket({
        sessionId,
        role,
        accessToken,
        name,
        admissionKey: admissionKeyRef.current,
      });
      socketRef.current = socket;
      let hasConnected = false;

      const joinRoom = () => {
        // Reconexão do socket gera um novo id: as conexões antigas não
        // valem mais e serão renegociadas a partir do novo join.
        if (hasConnected) {
          closeAllPeers();
          if (role === "guest") setAdmissionStatus("pending");
        }
        hasConnected = true;
        socket.emit("join-room");
      };

      socket.on("connect", () => {
        if (!cancelled) joinRoom();
      });
      if (socket.connected) joinRoom();

      socket.on("connect_error", (err: Error) => {
        if (!cancelled) reportError(err, "Connection error");
      });

      socket.on("room-full", () => {
        if (!cancelled) callbacksRef.current.onRoomFull?.();
      });

      // --- Sala de espera (guest) ---
      socket.on("waiting-for-approval", () => {
        if (!cancelled) setAdmissionStatus("waiting");
      });

      socket.on("admitted", ({ admissionKey: key }: { admissionKey: string }) => {
        if (cancelled) return;
        admissionKeyRef.current = key;
        // Reconexões automáticas do socket passam a levar a chave
        const withAuth = socket as Socket & { auth?: Record<string, unknown> };
        if (withAuth.auth && typeof withAuth.auth === "object") {
          withAuth.auth = { ...withAuth.auth, admissionKey: key };
        }
        setAdmissionStatus("admitted");
        callbacksRef.current.onAdmitted?.(key);
      });

      socket.on("admission-denied", () => {
        if (cancelled) return;
        setAdmissionStatus("denied");
        callbacksRef.current.onAdmissionDenied?.();
      });

      // --- Aprovação (host) ---
      socket.on("waiting-list", ({ guests }: { guests: WaitingGuest[] }) => {
        if (!cancelled) setWaitingGuests(guests);
      });

      socket.on("guest-waiting", (guest: WaitingGuest) => {
        if (cancelled) return;
        setWaitingGuests((prev) =>
          prev.some((g) => g.guestId === guest.guestId) ? prev : [...prev, guest],
        );
      });

      socket.on("admission-error", () => {
        if (!cancelled) {
          reportError(null, "A sala atingiu o limite de participantes.");
        }
      });

      // --- Negociação em malha ---
      // Quem acaba de entrar recebe a lista de quem já está e cria as offers
      socket.on(
        "room-peers",
        ({ peers }: { peers: { peerId: string; role: Role; name: string }[] }) => {
          if (cancelled) return;
          setAdmissionStatus("admitted");
          for (const peer of peers) {
            upsertParticipant(peer.peerId, {
              role: peer.role,
              name: peer.name,
              connectionState: "connecting",
            });
            createPeer(peer.peerId, true);
            void sendOffer(peer.peerId);
          }
        },
      );

      // Os demais só registram quem chegou e aguardam a offer
      socket.on(
        "user-joined",
        ({ peerId, role: peerRole, name: peerName }: { peerId: string; role: Role; name: string }) => {
          if (cancelled) return;
          upsertParticipant(peerId, {
            role: peerRole,
            name: peerName,
            connectionState: "connecting",
          });
        },
      );

      socket.on(
        "offer",
        async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
          if (cancelled) return;
          let entry = peersRef.current.get(from);
          if (!entry) {
            upsertParticipant(from, {});
            entry = createPeer(from, false);
          }
          try {
            await entry.pc.setRemoteDescription(offer);
            entry.remoteDescriptionSet = true;
            await flushPendingCandidates(entry);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            socket.emit("answer", { to: from, answer: entry.pc.localDescription });
          } catch (err) {
            reportError(err, "Failed to create answer");
          }
        },
      );

      socket.on(
        "answer",
        async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
          if (cancelled) return;
          const entry = peersRef.current.get(from);
          if (!entry) return;
          try {
            await entry.pc.setRemoteDescription(answer);
            entry.remoteDescriptionSet = true;
            await flushPendingCandidates(entry);
          } catch (err) {
            reportError(err, "Failed to set remote description");
          }
        },
      );

      socket.on(
        "ice-candidate",
        async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
          if (cancelled) return;
          const entry = peersRef.current.get(from);
          if (!entry) return;
          if (!entry.remoteDescriptionSet) {
            entry.pendingCandidates.push(candidate);
            return;
          }
          try {
            await entry.pc.addIceCandidate(candidate);
          } catch (err) {
            console.warn("Failed to add ICE candidate:", err);
          }
        },
      );

      socket.on("user-left", ({ peerId }: { peerId: string }) => {
        if (!cancelled) closePeer(peerId);
      });

      socket.on("session-ended", () => {
        if (!cancelled) callbacksRef.current.onSessionEnded?.();
      });
    };

    void setup();

    return () => {
      cancelled = true;
      endCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, role, accessToken, name]);

  const admitGuest = useCallback((guestId: string) => {
    socketRef.current?.emit("admit-guest", { guestId });
    setWaitingGuests((prev) => prev.filter((g) => g.guestId !== guestId));
  }, []);

  const denyGuest = useCallback((guestId: string) => {
    socketRef.current?.emit("deny-guest", { guestId });
    setWaitingGuests((prev) => prev.filter((g) => g.guestId !== guestId));
  }, []);

  const toggleMic = useCallback(() => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMicMuted(!audioTrack.enabled);
    }
  }, []);

  const toggleCamera = useCallback(() => {
    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsCameraOff(!videoTrack.enabled);
    }
  }, []);

  // Estado geral da chamada, para o indicador visual
  const connectionState = useMemo<ConnectionState>(() => {
    if (mediaState === "failed") return "failed";
    if (mediaState === "idle") return "idle";
    const states = participants.map((p) => p.connectionState);
    if (states.includes("reconnecting")) return "reconnecting";
    if (states.includes("connected")) return "connected";
    if (states.length > 0 && states.every((s) => s === "failed")) return "failed";
    return "connecting";
  }, [mediaState, participants]);

  return {
    localStream,
    participants,
    waitingGuests,
    admissionStatus,
    isMicMuted,
    isCameraOff,
    connectionState,
    toggleMic,
    toggleCamera,
    admitGuest,
    denyGuest,
    endCall,
  };
};
