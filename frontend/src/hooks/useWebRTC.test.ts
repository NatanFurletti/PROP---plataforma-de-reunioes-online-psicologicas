import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  createFakeStream,
  createdPeerConnections,
  installWebRTCMocks,
  stubGetUserMedia,
} from "../test/webrtcMocks";

// Socket falso com registry de handlers, para simular eventos do servidor
const handlers = new Map<string, (payload?: unknown) => void>();
const socketMock = {
  emit: vi.fn(),
  on: vi.fn((event: string, cb: (payload?: unknown) => void) => {
    handlers.set(event, cb);
  }),
  connected: false,
  id: "socket-test",
};

vi.mock("../services/socket", () => ({
  initializeSocket: vi.fn(() => socketMock),
  closeSocket: vi.fn(),
  getSocket: vi.fn(() => socketMock),
}));

const { useWebRTC } = await import("./useWebRTC");

// Dispara um evento como se viesse do servidor de sinalização
function serverEmit(event: string, payload?: unknown) {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`Sem handler registrado para "${event}"`);
  handler(payload);
}

const HOST_OPTS = { sessionId: "s1", role: "host" as const };
const GUEST_OPTS = {
  sessionId: "s1",
  role: "guest" as const,
  accessToken: "tok",
};

beforeEach(() => {
  handlers.clear();
  socketMock.emit.mockClear();
  socketMock.on.mockClear();
  installWebRTCMocks();
  stubGetUserMedia(async () => createFakeStream());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useWebRTC — inicialização de mídia", () => {
  it("expõe o stream local após getUserMedia", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    expect(result.current.connectionState).toBe("connecting");
  });

  it("solicita áudio e vídeo", async () => {
    const getUserMedia = stubGetUserMedia(async () => createFakeStream());
    renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: true, video: expect.anything() }),
    );
  });

  it("permissão negada → connectionState 'failed' e onError chamado", async () => {
    stubGetUserMedia(async () => {
      throw new Error("Permission denied");
    });
    const onError = vi.fn();

    const { result } = renderHook(() => useWebRTC({ ...HOST_OPTS, onError }));

    await waitFor(() => expect(result.current.connectionState).toBe("failed"));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(result.current.localStream).toBeNull();
  });

  it("adiciona os tracks locais à peer connection", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    // 1 track de áudio + 1 de vídeo
    expect(createdPeerConnections[0].addTrack).toHaveBeenCalledTimes(2);
  });
});

describe("useWebRTC — controles de mídia", () => {
  it("toggleMic alterna o estado do microfone", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    expect(result.current.isMicMuted).toBe(false);
    act(() => result.current.toggleMic());
    expect(result.current.isMicMuted).toBe(true);
    act(() => result.current.toggleMic());
    expect(result.current.isMicMuted).toBe(false);
  });

  it("toggleCamera alterna o estado da câmera", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    expect(result.current.isCameraOff).toBe(false);
    act(() => result.current.toggleCamera());
    expect(result.current.isCameraOff).toBe(true);
    act(() => result.current.toggleCamera());
    expect(result.current.isCameraOff).toBe(false);
  });

  it("toggleMic desabilita o track de áudio, não o de vídeo", async () => {
    const stream = createFakeStream();
    stubGetUserMedia(async () => stream);

    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.toggleMic());
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
    expect(stream.getVideoTracks()[0].enabled).toBe(true);
  });
});

describe("useWebRTC — negociação", () => {
  it("host cria offer quando o guest entra", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      serverEmit("user-joined", { role: "guest" });
    });

    const pc = createdPeerConnections[0];
    expect(pc.createOffer).toHaveBeenCalled();
    expect(socketMock.emit).toHaveBeenCalledWith(
      "offer",
      expect.objectContaining({ offer: expect.anything() }),
    );
  });

  it("guest não cria offer ao receber user-joined", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      serverEmit("user-joined", { role: "host" });
    });

    expect(createdPeerConnections[0].createOffer).not.toHaveBeenCalled();
  });

  it("guest responde offer com answer", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      serverEmit("offer", { offer: { type: "offer", sdp: "remote-sdp" } });
    });

    const pc = createdPeerConnections[0];
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(socketMock.emit).toHaveBeenCalledWith(
      "answer",
      expect.objectContaining({ answer: expect.anything() }),
    );
  });

  it("host aplica a answer recebida", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      serverEmit("answer", { answer: { type: "answer", sdp: "remote-sdp" } });
    });

    expect(createdPeerConnections[0].setRemoteDescription).toHaveBeenCalled();
  });

  it("bufferiza ICE candidates recebidos antes da remote description", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    const pc = createdPeerConnections[0];

    // Candidato chega antes de qualquer offer — deve ser bufferizado
    await act(async () => {
      serverEmit("ice-candidate", { candidate: { candidate: "cand-1" } });
    });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    // Após a offer, o buffer é drenado
    await act(async () => {
      serverEmit("offer", { offer: { type: "offer", sdp: "remote-sdp" } });
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: "cand-1" });
  });

  it("aplica ICE candidates diretamente após a remote description", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      serverEmit("offer", { offer: { type: "offer", sdp: "remote-sdp" } });
    });

    const pc = createdPeerConnections[0];
    pc.addIceCandidate.mockClear();

    await act(async () => {
      serverEmit("ice-candidate", { candidate: { candidate: "cand-2" } });
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: "cand-2" });
  });
});

describe("useWebRTC — eventos de sessão", () => {
  it("chama onSessionEnded ao receber session-ended", async () => {
    const onSessionEnded = vi.fn();
    const { result } = renderHook(() =>
      useWebRTC({ ...GUEST_OPTS, onSessionEnded }),
    );
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("session-ended"));
    expect(onSessionEnded).toHaveBeenCalled();
  });

  it("chama onRoomFull ao receber room-full", async () => {
    const onRoomFull = vi.fn();
    const { result } = renderHook(() =>
      useWebRTC({ ...GUEST_OPTS, onRoomFull }),
    );
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("room-full", { error: "cheia" }));
    expect(onRoomFull).toHaveBeenCalled();
  });

  it("limpa o stream remoto quando o par sai", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    // Simula o track remoto chegando
    await act(async () => {
      createdPeerConnections[0].ontrack?.({ streams: [createFakeStream()] });
    });
    expect(result.current.remoteStream).not.toBeNull();

    await act(async () => serverEmit("user-left"));
    expect(result.current.remoteStream).toBeNull();
  });
});

describe("useWebRTC — encerramento", () => {
  it("endCall para os tracks e fecha a peer connection", async () => {
    const stream = createFakeStream();
    stubGetUserMedia(async () => stream);

    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    const pc = createdPeerConnections[0];

    act(() => result.current.endCall());

    for (const track of stream.tracks) {
      expect(track.readyState).toBe("ended");
    }
    expect(pc.close).toHaveBeenCalled();
    expect(pc.signalingState).toBe("closed");
    expect(result.current.localStream).toBeNull();
  });

  it("host emite session-end ao encerrar", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.endCall());
    expect(socketMock.emit).toHaveBeenCalledWith("session-end");
  });

  it("guest não emite session-end ao encerrar", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.endCall());
    expect(socketMock.emit).not.toHaveBeenCalledWith("session-end");
  });

  it("desmontar o hook libera os tracks de mídia", async () => {
    const stream = createFakeStream();
    stubGetUserMedia(async () => stream);

    const { result, unmount } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    unmount();
    for (const track of stream.tracks) {
      expect(track.readyState).toBe("ended");
    }
  });
});

describe("useWebRTC — reconexão", () => {
  it("marca 'connected' quando a conexão é estabelecida", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      createdPeerConnections[0].emitConnectionState("connected");
    });
    expect(result.current.connectionState).toBe("connected");
  });

  it("entra em 'reconnecting' na primeira falha, sem desistir", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      createdPeerConnections[0].emitConnectionState("failed");
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("desiste com 'failed' e onError após 3 tentativas", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { result } = renderHook(() => useWebRTC({ ...HOST_OPTS, onError }));

    await vi.waitFor(() => expect(result.current.localStream).not.toBeNull());
    const pc = createdPeerConnections[0];

    // 3 falhas consecutivas esgotam as tentativas; a 4ª desiste
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        pc.emitConnectionState("failed");
        await vi.advanceTimersByTimeAsync(10_000);
      });
    }

    expect(result.current.connectionState).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    vi.useRealTimers();
  });
});
