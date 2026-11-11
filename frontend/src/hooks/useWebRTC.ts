import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { initializeSocket, closeSocket, updateSocketAuth } from "../services/socket";
import { sessionService } from "../services/api";

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
  // Quadros de vídeo chegando agora. false = sem câmera, vídeo parado (aba
  // em segundo plano, queda) — a UI mostra um avatar em vez do quadro congelado
  isVideoFlowing: boolean;
  // Microfone desligado (pelo próprio participante ou pelo psicólogo)
  isMicMuted: boolean;
  // Paciente com a mão levantada: carimbo do servidor (ordem de quem
  // levantou primeiro). null = mão abaixada.
  handRaisedAt: number | null;
}

interface PeerInfo {
  peerId: string;
  role: Role;
  name: string;
  micMuted?: boolean;
  handRaisedAt?: number | null;
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
  // Guest: chave que identifica o paciente (entregue na espera e na aprovação)
  onAdmissionKey?: (admissionKey: string) => void;
  onAdmitted?: (admissionKey: string) => void;
  onAdmissionDenied?: () => void;
  onSessionEnded?: () => void;
  onRoomFull?: () => void;
  // O psicólogo desligou o microfone deste participante
  onForceMuted?: () => void;
  onError?: (error: Error) => void;
}

interface UseWebRTCReturn {
  localStream: MediaStream | null;
  participants: RemoteParticipant[];
  waitingGuests: WaitingGuest[];
  admissionStatus: AdmissionStatus;
  isMicMuted: boolean;
  isCameraOff: boolean;
  // Paciente: mão levantada (atualiza na hora do clique)
  isHandRaised: boolean;
  // Carimbo do servidor da própria mão, para saber a posição na fila.
  // null enquanto o servidor não confirmar ou com a mão abaixada.
  handRaisedAt: number | null;
  connectionState: ConnectionState;
  // Socket da chamada, para recursos que usam a mesma conexão (ex.: chat).
  // null antes de conectar e depois de encerrar.
  socket: Socket | null;
  toggleMic: () => void;
  toggleCamera: () => void;
  admitGuest: (guestId: string) => void;
  denyGuest: (guestId: string) => void;
  // Host: desliga o microfone de outro participante (só ele religa)
  muteParticipant: (peerId: string) => void;
  // Paciente: levanta/abaixa a própria mão
  toggleHand: () => void;
  // Host: abaixa a mão de um paciente
  lowerHand: (peerId: string) => void;
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
  // Mídia recebida do par (montada a partir dos tracks de ontrack)
  remoteStream: MediaStream | null;
  // Detecção de vídeo parado (via getStats)
  framesDecoded: number;
  lastFrameAt: number;
  videoFlowing: boolean;
}

// Sender de um tipo de mídia, mesmo quando ainda não há track (ex.: entrou
// só com áudio e a câmera é ligada depois)
function findSender(
  pc: RTCPeerConnection,
  kind: "audio" | "video",
  old?: MediaStreamTrack,
): RTCRtpSender | undefined {
  const senders = pc.getSenders();
  return (
    (old ? senders.find((s) => s.track === old) : undefined) ??
    senders.find((s) => s.track?.kind === kind) ??
    pc.getTransceivers().find((t) => t.receiver.track?.kind === kind)?.sender
  );
}

const MAX_RECONNECT_ATTEMPTS = 3;

// Sem quadro novo por este tempo, o vídeo do par é considerado parado
const VIDEO_STALL_MS = 3000;
const VIDEO_CHECK_INTERVAL_MS = 1000;

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

function buildIceServers(): RTCIceServer[] {
  const iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  // Aceita várias URLs separadas por vírgula (ex.: UDP 80, TCP 443 e TLS
  // 443): redes que bloqueiam UDP ainda conectam pelo TURN via 443
  const turnUrls = ((import.meta.env.VITE_TURN_URL as string | undefined) ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME as string,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string,
    });
  }
  return iceServers;
}

const CAMERA_RETRY_DELAY_MS = 1000;

// Erros de captura que costumam passar sozinhos (dispositivo ainda ocupado)
function isTransientMediaError(err: unknown): boolean {
  return err instanceof Error && /NotReadableError|AbortError/.test(err.name);
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
  onAdmissionKey,
  onAdmitted,
  onAdmissionDenied,
  onSessionEnded,
  onRoomFull,
  onForceMuted,
  onError,
}: UseWebRTCOptions): UseWebRTCReturn => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [waitingGuests, setWaitingGuests] = useState<WaitingGuest[]>([]);
  const [admissionStatus, setAdmissionStatus] = useState<AdmissionStatus>(
    role === "host" ? "admitted" : "pending",
  );
  const [isMicMuted, setIsMicMuted] = useState(false);
  // Valor atual para handlers do socket (join-room, room-peers)
  const micMutedRef = useRef(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [handRaisedAt, setHandRaisedAt] = useState<number | null>(null);
  // Valor atual para handlers do socket (join-room, room-peers)
  const handRaisedRef = useRef(false);
  // Estado da mídia local; o estado da chamada é derivado dos participantes
  const [mediaState, setMediaState] = useState<"idle" | "ready" | "failed">(
    "idle",
  );

  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, PeerEntry>());
  const admissionKeyRef = useRef(admissionKey);
  // Esta aba foi substituída por outra conexão da mesma pessoa
  const replacedRef = useRef(false);

  // Referências estáveis para callbacks, evitando re-registro de handlers
  const callbacksRef = useRef({
    onAdmissionKey,
    onAdmitted,
    onAdmissionDenied,
    onSessionEnded,
    onRoomFull,
    onForceMuted,
    onError,
  });
  useEffect(() => {
    callbacksRef.current = {
      onAdmissionKey,
      onAdmitted,
      onAdmissionDenied,
      onSessionEnded,
      onRoomFull,
      onForceMuted,
      onError,
    };
  }, [
    onAdmissionKey,
    onAdmitted,
    onAdmissionDenied,
    onSessionEnded,
    onRoomFull,
    onForceMuted,
    onError,
  ]);

  // Liga/desliga o microfone local e avisa os demais participantes
  const applyMicMuted = useCallback((muted: boolean) => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = !muted;
    micMutedRef.current = muted;
    setIsMicMuted(muted);
    socketRef.current?.emit("mic-state", { muted });
  }, []);

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
              isVideoFlowing: false,
              isMicMuted: false,
              handRaisedAt: null,
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
        remoteStream: null,
        framesDecoded: 0,
        lastFrameAt: 0,
        videoFlowing: false,
      };
      peersRef.current.set(peerId, entry);

      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => pc.addTrack(track, stream));
      // Sem câmera (ou microfone), reserva o canal na offer: ligar depois
      // é só um replaceTrack, sem renegociar
      if (stream && isOfferer) {
        for (const kind of ["audio", "video"] as const) {
          if (!stream.getTracks().some((t) => t.kind === kind)) {
            pc.addTransceiver(kind, { direction: "sendrecv", streams: [stream] });
          }
        }
      }

      pc.ontrack = (event) => {
        const base = event.streams[0];
        if (base && (!entry.remoteStream || entry.remoteStream === base)) {
          entry.remoteStream = base;
        } else {
          // Track sem stream associado (canal reservado do outro lado):
          // junta com o que já chegou para não perder o áudio
          const tracks = new Set([
            ...(entry.remoteStream?.getTracks() ?? []),
            ...(base?.getTracks() ?? []),
            event.track,
          ]);
          entry.remoteStream = new MediaStream([...tracks]);
        }
        upsertParticipant(peerId, { stream: entry.remoteStream });
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
    setSocket(null);
    closeSocket();

    setLocalStream(null);
    setParticipants([]);
    setWaitingGuests([]);
    setMediaState("idle");
    handRaisedRef.current = false;
    setIsHandRaised(false);
    setHandRaisedAt(null);
  }, [role]);

  // Reanima conexões P2P que caíram (ex.: o celular ficou em segundo
  // plano). Quem criou a offer faz o ICE restart; o outro lado pede.
  const recoverPeers = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    for (const [peerId, entry] of peersRef.current) {
      const state = entry.pc.connectionState;
      if (state !== "failed" && state !== "disconnected") continue;
      entry.reconnectAttempts = 0;
      upsertParticipant(peerId, { connectionState: "reconnecting" });
      if (entry.isOfferer) {
        void sendOffer(peerId, true);
      } else {
        socket.emit("restart-ice", { to: peerId });
      }
    }
  }, [upsertParticipant, sendOffer]);

  // O sistema pode encerrar a câmera/microfone enquanto a página está em
  // segundo plano (ou outro app pega a câmera). Na volta, captura de novo
  // e troca o track nas conexões, sem renegociar.
  const restoringRef = useRef(false);
  const restoreLocalTracks = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || restoringRef.current) return;
    if (document.visibilityState !== "visible") return;
    const ended = stream.getTracks().filter((t) => t.readyState === "ended");
    if (ended.length === 0) return;

    restoringRef.current = true;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: ended.some((t) => t.kind === "audio"),
        video: ended.some((t) => t.kind === "video") ? VIDEO_CONSTRAINTS : false,
      });
      // A chamada acabou enquanto esperava a permissão
      if (localStreamRef.current !== stream) {
        fresh.getTracks().forEach((t) => t.stop());
        return;
      }

      const replacements = fresh.getTracks();
      for (const track of replacements) {
        const old = ended.find((t) => t.kind === track.kind);
        // Mantém o estado de mudo / câmera desligada escolhido pelo usuário
        if (old) track.enabled = old.enabled;
        watchTrack(track);
        for (const entry of peersRef.current.values()) {
          const kind = track.kind === "audio" ? "audio" : "video";
          await findSender(entry.pc, kind, old)?.replaceTrack(track);
        }
      }

      const next = new MediaStream([
        ...stream.getTracks().filter((t) => t.readyState !== "ended"),
        ...replacements,
      ]);
      localStreamRef.current = next;
      setLocalStream(next);
    } catch (err) {
      reportError(err, "Failed to access media devices");
    } finally {
      restoringRef.current = false;
    }
    // watchTrack é estável (usa ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportError]);

  const restoreRef = useRef(restoreLocalTracks);
  useEffect(() => {
    restoreRef.current = restoreLocalTracks;
  }, [restoreLocalTracks]);
  // stop() não dispara "ended": isto só roda quando o sistema encerra o track
  function watchTrack(track: MediaStreamTrack): void {
    track.onended = () => {
      void restoreRef.current();
    };
  }

  // Volta do segundo plano / rede voltou: reconecta o socket na hora (sem
  // esperar o backoff), recaptura mídia encerrada e reanima as conexões.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== "visible" || replacedRef.current) return;
      const socket = socketRef.current;
      if (socket && !socket.connected) socket.connect();
      void restoreLocalTracks();
      recoverPeers();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("pageshow", onResume);
    };
  }, [restoreLocalTracks, recoverPeers]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      // 1. Câmera e microfone
      let stream: MediaStream | null = null;
      let videoError: unknown = null;
      const captureAll = () =>
        navigator.mediaDevices.getUserMedia({ audio: true, video: VIDEO_CONSTRAINTS });
      try {
        stream = await captureAll();
      } catch (err) {
        videoError = err;
        // No Windows a câmera pode levar um instante para ser liberada (aba
        // anterior, StrictMode em dev, driver lento): tenta mais uma vez
        if (isTransientMediaError(err)) {
          await new Promise((resolve) => setTimeout(resolve, CAMERA_RETRY_DELAY_MS));
          if (cancelled) return;
          try {
            stream = await captureAll();
            videoError = null;
          } catch (retryErr) {
            videoError = retryErr;
          }
        }
      }
      if (!stream) {
        // Câmera ocupada, bloqueada ou ausente: entra só com áudio em vez
        // de não entrar
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          if (cancelled) return;
          setMediaState("failed");
          reportError(videoError, "Failed to access media devices");
          return;
        }
      }
      const audioOnly = videoError !== null;

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      stream.getTracks().forEach(watchTrack);
      setLocalStream(stream);
      setMediaState("ready");
      if (audioOnly) {
        setIsCameraOff(true);
        // Mantém o tipo do erro original (ex.: NotAllowedError) para a
        // mensagem dizer o motivo certo
        const cause = videoError instanceof Error ? videoError.name : "Error";
        console.warn("Camera unavailable:", cause);
        const error = new Error("Camera unavailable: joined with audio only");
        error.name = cause;
        reportError(error, "Camera unavailable: joined with audio only");
      }

      // 2. Sinalização autenticada
      const socket = initializeSocket({
        sessionId,
        role,
        accessToken,
        name,
        admissionKey: admissionKeyRef.current,
        getHostToken:
          role === "host"
            ? async () => (await sessionService.getSocketToken(sessionId)).data.token
            : undefined,
      });
      socketRef.current = socket;
      setSocket(socket);
      let hasConnected = false;

      // Estado atual do microfone e da mão, para manter após reconexões
      const joinPayload = () => ({
        micMuted: micMutedRef.current,
        handRaised: handRaisedRef.current,
      });

      const joinRoom = () => {
        if (hasConnected && socket.recovered) {
          // Socket recuperado (mesmo id, ex.: voltou do segundo plano): as
          // conexões P2P continuam valendo. O join só confirma a volta ao
          // servidor; depois tenta reanimar as conexões que caíram.
          socket.emit("join-room", joinPayload());
          recoverPeers();
          return;
        }
        // Reconexão sem recuperação gera um novo id: as conexões antigas
        // não valem mais e serão renegociadas a partir do novo join.
        if (hasConnected) {
          closeAllPeers();
          if (role === "guest") setAdmissionStatus("pending");
        }
        hasConnected = true;
        socket.emit("join-room", joinPayload());
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
      // A chave identifica o paciente: reconexões e novas visitas pelo
      // link levam ela, para o servidor reconhecer a mesma pessoa
      const rememberKey = (key: unknown) => {
        if (typeof key !== "string" || key === admissionKeyRef.current) return;
        admissionKeyRef.current = key;
        updateSocketAuth({ admissionKey: key });
        callbacksRef.current.onAdmissionKey?.(key);
      };

      socket.on("waiting-for-approval", (payload?: { admissionKey?: string }) => {
        if (cancelled) return;
        rememberKey(payload?.admissionKey);
        setAdmissionStatus("waiting");
      });

      socket.on("admitted", ({ admissionKey: key }: { admissionKey: string }) => {
        if (cancelled) return;
        rememberKey(key);
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
        ({ peers }: { peers: PeerInfo[] }) => {
          if (cancelled) return;
          setAdmissionStatus("admitted");
          // Garante que os demais vejam o estado atual do microfone (pode ter
          // mudado enquanto aguardava a aprovação)
          socket.emit("mic-state", { muted: micMutedRef.current });
          if (handRaisedRef.current) socket.emit("raise-hand", { raised: true });
          // room-peers é a foto completa da sala na entrada: conexões que
          // sobraram de antes (ex.: tolerância expirou) não valem mais
          closeAllPeers();
          for (const peer of peers) {
            upsertParticipant(peer.peerId, {
              role: peer.role,
              name: peer.name,
              connectionState: "connecting",
              isMicMuted: peer.micMuted === true,
              handRaisedAt: peer.handRaisedAt ?? null,
            });
            createPeer(peer.peerId, true);
            void sendOffer(peer.peerId);
          }
        },
      );

      // Os demais só registram quem chegou e aguardam a offer
      socket.on(
        "user-joined",
        ({ peerId, role: peerRole, name: peerName, micMuted, handRaisedAt: raisedAt }: PeerInfo) => {
          if (cancelled) return;
          upsertParticipant(peerId, {
            role: peerRole,
            name: peerName,
            connectionState: "connecting",
            isMicMuted: micMuted === true,
            handRaisedAt: raisedAt ?? null,
          });
        },
      );

      // --- Microfone ---
      socket.on(
        "peer-mic-state",
        ({ peerId, muted }: { peerId: string; muted: boolean }) => {
          if (cancelled) return;
          // Só atualiza quem já está na lista (evita criar um par fantasma)
          setParticipants((prev) =>
            prev.map((p) => (p.peerId === peerId ? { ...p, isMicMuted: muted } : p)),
          );
        },
      );

      // --- Mão levantada ---
      // Vai para todos da sala, inclusive quem levantou (o carimbo do
      // servidor define a posição na fila)
      socket.on(
        "hand-state",
        ({ peerId, raisedAt }: { peerId: string; raisedAt: number | null }) => {
          if (cancelled) return;
          if (peerId === socket.id) {
            // Inclui o psicólogo abaixando a mão deste paciente
            handRaisedRef.current = raisedAt !== null;
            setIsHandRaised(raisedAt !== null);
            setHandRaisedAt(raisedAt);
            return;
          }
          setParticipants((prev) =>
            prev.map((p) => (p.peerId === peerId ? { ...p, handRaisedAt: raisedAt } : p)),
          );
        },
      );

      // O psicólogo desligou este microfone. Fica mudo até a própria
      // pessoa religar.
      socket.on("force-muted", () => {
        if (cancelled) return;
        applyMicMuted(true);
        callbacksRef.current.onForceMuted?.();
      });

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
            // Canal sem track local (ex.: sem câmera) fica como recvonly;
            // sendrecv permite ligar a câmera depois sem renegociar
            for (const t of entry.pc.getTransceivers()) {
              if (!t.sender.track && t.direction === "recvonly") {
                t.direction = "sendrecv";
              }
            }
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

      // O outro lado pediu um ICE restart (só quem criou a offer faz)
      socket.on("restart-ice", ({ from }: { from: string }) => {
        if (cancelled) return;
        const entry = peersRef.current.get(from);
        if (!entry?.isOfferer) return;
        entry.reconnectAttempts = 0;
        void sendOffer(from, true);
      });

      // A mesma pessoa entrou de novo em outra aba/dispositivo: esta
      // conexão foi substituída e não deve tentar voltar
      socket.on("session-replaced", () => {
        if (cancelled) return;
        replacedRef.current = true;
        closeAllPeers();
        reportError(null, "Session opened in another tab or device");
      });

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

  const muteParticipant = useCallback(
    (peerId: string) => {
      if (role !== "host") return;
      socketRef.current?.emit("mute-participant", { peerId });
      // Mostra o mudo na hora; o servidor confirma via peer-mic-state
      setParticipants((prev) =>
        prev.map((p) => (p.peerId === peerId ? { ...p, isMicMuted: true } : p)),
      );
    },
    [role],
  );

  const toggleHand = useCallback(() => {
    if (role !== "guest") return;
    const raised = !handRaisedRef.current;
    handRaisedRef.current = raised;
    setIsHandRaised(raised);
    // A posição na fila só vale com o carimbo do servidor (hand-state)
    if (!raised) setHandRaisedAt(null);
    socketRef.current?.emit("raise-hand", { raised });
  }, [role]);

  const lowerHand = useCallback(
    (peerId: string) => {
      if (role !== "host") return;
      socketRef.current?.emit("lower-hand", { peerId });
      // Mostra na hora; o servidor confirma via hand-state
      setParticipants((prev) =>
        prev.map((p) => (p.peerId === peerId ? { ...p, handRaisedAt: null } : p)),
      );
    },
    [role],
  );

  const toggleMic = useCallback(() => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) applyMicMuted(audioTrack.enabled);
  }, [applyMicMuted]);

  // Liga a câmera quando a chamada começou sem ela (estava ocupada)
  const startingCameraRef = useRef(false);
  const startCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || startingCameraRef.current) return;
    startingCameraRef.current = true;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: VIDEO_CONSTRAINTS,
      });
      const track = fresh.getVideoTracks()[0];
      if (!track) return;
      if (localStreamRef.current !== stream) {
        track.stop();
        return;
      }
      watchTrack(track);
      for (const entry of peersRef.current.values()) {
        await findSender(entry.pc, "video")?.replaceTrack(track);
      }
      const next = new MediaStream([
        ...stream.getTracks().filter((t) => t.kind !== "video"),
        track,
      ]);
      localStreamRef.current = next;
      setLocalStream(next);
      setIsCameraOff(false);
    } catch (err) {
      reportError(err, "Could not start video source");
    } finally {
      startingCameraRef.current = false;
    }
    // watchTrack é estável (usa ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportError]);

  const toggleCamera = useCallback(() => {
    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (videoTrack && videoTrack.readyState === "live") {
      videoTrack.enabled = !videoTrack.enabled;
      setIsCameraOff(!videoTrack.enabled);
      return;
    }
    void startCamera();
  }, [startCamera]);

  // Vídeo travado: quando o par cai ou a aba dele vai para o segundo plano,
  // o <video> fica no último quadro. Os contadores de quadros decodificados
  // dizem se o vídeo ainda chega, independente do estado da conexão.
  useEffect(() => {
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        for (const [peerId, entry] of peersRef.current) {
          if (typeof entry.pc.getStats !== "function") continue;
          let frames = 0;
          let hasVideo = false;
          try {
            const report = await entry.pc.getStats();
            report.forEach((stat: { type?: string; kind?: string; framesDecoded?: number }) => {
              if (stat.type === "inbound-rtp" && stat.kind === "video") {
                hasVideo = true;
                frames += stat.framesDecoded ?? 0;
              }
            });
          } catch {
            continue;
          }
          // O par saiu ou foi substituído enquanto lia as estatísticas
          if (peersRef.current.get(peerId) !== entry) continue;
          const now = Date.now();
          if (frames > entry.framesDecoded) {
            entry.framesDecoded = frames;
            entry.lastFrameAt = now;
          }
          const flowing = hasVideo && now - entry.lastFrameAt < VIDEO_STALL_MS;
          if (flowing !== entry.videoFlowing) {
            entry.videoFlowing = flowing;
            upsertParticipant(peerId, { isVideoFlowing: flowing });
          }
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), VIDEO_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [upsertParticipant]);

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
    isHandRaised,
    handRaisedAt,
    connectionState,
    socket,
    toggleMic,
    toggleCamera,
    admitGuest,
    denyGuest,
    muteParticipant,
    toggleHand,
    lowerHand,
    endCall,
  };
};
