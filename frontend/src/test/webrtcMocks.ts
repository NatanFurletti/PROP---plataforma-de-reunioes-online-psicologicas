import { vi, type Mock } from "vitest";

// jsdom não implementa WebRTC nem getUserMedia — estes fakes cobrem
// apenas a superfície usada por useWebRTC.

export interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
  readyState: "live" | "ended";
  stop: () => void;
}

export function createFakeTrack(kind: "audio" | "video"): FakeTrack {
  const track: FakeTrack = {
    kind,
    enabled: true,
    readyState: "live",
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };
  return track;
}

export function createFakeStream(
  tracks: FakeTrack[] = [createFakeTrack("audio"), createFakeTrack("video")],
): MediaStream & { tracks: FakeTrack[] } {
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream & { tracks: FakeTrack[] };
}

export interface FakeSender {
  track: FakeTrack | null;
  replaceTrack: ReturnType<typeof vi.fn>;
}

export interface FakeTransceiver {
  direction: string;
  sender: FakeSender;
  receiver: { track: { kind: "audio" | "video" } };
}

export interface FakePeerConnection {
  connectionState: string;
  signalingState: string;
  iceConnectionState: string;
  localDescription: unknown;
  onicecandidate: ((ev: unknown) => void) | null;
  ontrack: ((ev: unknown) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  addTrack: ReturnType<typeof vi.fn>;
  getSenders: () => FakeSender[];
  addTransceiver: Mock<
    (kind: "audio" | "video", init?: { direction?: string }) => FakeTransceiver
  >;
  getTransceivers: () => FakeTransceiver[];
  createOffer: ReturnType<typeof vi.fn>;
  createAnswer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  addIceCandidate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  // Quadros de vídeo recebidos, informados por getStats
  framesDecoded: number;
  // Helpers de teste
  emitConnectionState: (state: string) => void;
}

// Todas as peer connections criadas durante um teste, em ordem
export const createdPeerConnections: FakePeerConnection[] = [];

export function installWebRTCMocks(): void {
  createdPeerConnections.length = 0;

  class MockRTCPeerConnection {
    connectionState = "new";
    signalingState = "stable";
    iceConnectionState = "new";
    localDescription: unknown = null;
    onicecandidate: ((ev: unknown) => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;

    senders: FakeSender[] = [];
    addTrack = vi.fn((track: FakeTrack) => {
      const sender: FakeSender = {
        track,
        replaceTrack: vi.fn(async (next: FakeTrack) => {
          sender.track = next;
        }),
      };
      this.senders.push(sender);
      return sender;
    });
    getSenders = () => this.senders;
    transceivers: FakeTransceiver[] = [];
    addTransceiver = vi.fn((kind: "audio" | "video", init?: { direction?: string }) => {
      const transceiver: FakeTransceiver = {
        direction: init?.direction ?? "sendrecv",
        sender: {
          track: null,
          replaceTrack: vi.fn(async (next: FakeTrack) => {
            transceiver.sender.track = next;
          }),
        },
        receiver: { track: { kind } },
      };
      this.transceivers.push(transceiver);
      return transceiver;
    });
    getTransceivers = () => this.transceivers;
    createOffer = vi.fn(async () => ({ type: "offer", sdp: "fake-offer" }));
    createAnswer = vi.fn(async () => ({ type: "answer", sdp: "fake-answer" }));
    setLocalDescription = vi.fn(async (desc: unknown) => {
      this.localDescription = desc;
    });
    setRemoteDescription = vi.fn(async () => {});
    addIceCandidate = vi.fn(async () => {});
    close = vi.fn(() => {
      this.signalingState = "closed";
    });
    framesDecoded = 0;
    getStats = vi.fn(
      async () =>
        new Map([
          ["in-video", { type: "inbound-rtp", kind: "video", framesDecoded: this.framesDecoded }],
        ]),
    );

    constructor() {
      createdPeerConnections.push(this as unknown as FakePeerConnection);
    }

    // Dispara a transição de estado como o browser faria
    emitConnectionState(state: string): void {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
  }

  vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
  // jsdom também não tem MediaStream
  vi.stubGlobal(
    "MediaStream",
    function FakeMediaStream(tracks: FakeTrack[] = []) {
      return createFakeStream(tracks);
    },
  );
}

export function stubGetUserMedia(
  impl: () => Promise<MediaStream>,
): Mock<() => Promise<MediaStream>> {
  const getUserMedia = vi.fn(impl);
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    mediaDevices: { getUserMedia },
  });
  return getUserMedia;
}
