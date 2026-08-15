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

export function createFakeStream(): MediaStream & { tracks: FakeTrack[] } {
  const tracks = [createFakeTrack("audio"), createFakeTrack("video")];
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream & { tracks: FakeTrack[] };
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
  createOffer: ReturnType<typeof vi.fn>;
  createAnswer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  addIceCandidate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
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

    addTrack = vi.fn();
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
