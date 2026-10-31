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
  updateSocketAuth: vi.fn(),
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
  name: "Maria",
};

const HOST_PEER = { peerId: "host-1", role: "host", name: "Psicólogo" };
const GUEST_PEER = { peerId: "guest-1", role: "guest", name: "Maria" };

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
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
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

describe("useWebRTC — sala de espera", () => {
  it("guest começa pendente e host já entra admitido", async () => {
    const guest = renderHook(() => useWebRTC(GUEST_OPTS));
    const host = renderHook(() => useWebRTC(HOST_OPTS));
    expect(guest.result.current.admissionStatus).toBe("pending");
    expect(host.result.current.admissionStatus).toBe("admitted");
  });

  it("guest passa para 'waiting' e depois 'admitted' com a chave", async () => {
    const onAdmitted = vi.fn();
    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onAdmitted }));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("waiting-for-approval"));
    expect(result.current.admissionStatus).toBe("waiting");

    await act(async () => serverEmit("admitted", { admissionKey: "key-1" }));
    expect(result.current.admissionStatus).toBe("admitted");
    expect(onAdmitted).toHaveBeenCalledWith("key-1");
  });

  it("guest recusado vai para 'denied'", async () => {
    const onAdmissionDenied = vi.fn();
    const { result } = renderHook(() =>
      useWebRTC({ ...GUEST_OPTS, onAdmissionDenied }),
    );
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("admission-denied"));
    expect(result.current.admissionStatus).toBe("denied");
    expect(onAdmissionDenied).toHaveBeenCalled();
  });

  it("guest não cria conexão enquanto aguarda", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("waiting-for-approval"));
    expect(createdPeerConnections).toHaveLength(0);
  });
});

describe("useWebRTC — aprovação pelo host", () => {
  it("lista pedidos recebidos e atualiza com a lista do servidor", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("guest-waiting", { guestId: "g1", name: "Maria" }));
    await act(async () => serverEmit("guest-waiting", { guestId: "g1", name: "Maria" }));
    expect(result.current.waitingGuests).toEqual([{ guestId: "g1", name: "Maria" }]);

    await act(async () => serverEmit("waiting-list", { guests: [] }));
    expect(result.current.waitingGuests).toEqual([]);
  });

  it("admitGuest envia admit-guest e tira o pedido da lista", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("guest-waiting", { guestId: "g1", name: "Maria" }));

    act(() => result.current.admitGuest("g1"));
    expect(socketMock.emit).toHaveBeenCalledWith("admit-guest", { guestId: "g1" });
    expect(result.current.waitingGuests).toEqual([]);
  });

  it("denyGuest envia deny-guest", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("guest-waiting", { guestId: "g1", name: "Maria" }));

    act(() => result.current.denyGuest("g1"));
    expect(socketMock.emit).toHaveBeenCalledWith("deny-guest", { guestId: "g1" });
  });
});

describe("useWebRTC — negociação em malha", () => {
  it("quem entra cria uma offer para cada par já presente", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => {
      serverEmit("room-peers", {
        peers: [HOST_PEER, { peerId: "guest-2", role: "guest", name: "João" }],
      });
    });

    expect(createdPeerConnections).toHaveLength(2);
    expect(socketMock.emit).toHaveBeenCalledWith(
      "offer",
      expect.objectContaining({ to: "host-1", offer: expect.anything() }),
    );
    expect(socketMock.emit).toHaveBeenCalledWith(
      "offer",
      expect.objectContaining({ to: "guest-2", offer: expect.anything() }),
    );
    expect(result.current.participants.map((p) => p.name)).toEqual([
      "Psicólogo",
      "João",
    ]);
    expect(result.current.admissionStatus).toBe("admitted");
  });

  it("user-joined só registra o par, sem criar offer", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("user-joined", GUEST_PEER));

    expect(createdPeerConnections).toHaveLength(0);
    expect(result.current.participants).toEqual([
      expect.objectContaining({ peerId: "guest-1", name: "Maria" }),
    ]);
  });

  it("responde a offer de um par com answer endereçada a ele", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("user-joined", GUEST_PEER));
    await act(async () => {
      serverEmit("offer", { from: "guest-1", offer: { type: "offer", sdp: "remote" } });
    });

    const pc = createdPeerConnections[0];
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(socketMock.emit).toHaveBeenCalledWith(
      "answer",
      expect.objectContaining({ to: "guest-1", answer: expect.anything() }),
    );
  });

  it("aplica a answer na conexão do par certo", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => {
      serverEmit("room-peers", {
        peers: [HOST_PEER, { peerId: "guest-2", role: "guest", name: "João" }],
      });
    });

    await act(async () => {
      serverEmit("answer", { from: "guest-2", answer: { type: "answer", sdp: "a" } });
    });

    expect(createdPeerConnections[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(createdPeerConnections[1].setRemoteDescription).toHaveBeenCalled();
  });

  it("bufferiza ICE candidates recebidos antes da remote description", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    const pc = createdPeerConnections[0];

    await act(async () => {
      serverEmit("ice-candidate", { from: "host-1", candidate: { candidate: "c1" } });
    });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await act(async () => {
      serverEmit("answer", { from: "host-1", answer: { type: "answer", sdp: "a" } });
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: "c1" });

    await act(async () => {
      serverEmit("ice-candidate", { from: "host-1", candidate: { candidate: "c2" } });
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: "c2" });
  });

  it("envia ICE candidates locais endereçados ao par", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));

    createdPeerConnections[0].onicecandidate?.({ candidate: { candidate: "local" } });
    expect(socketMock.emit).toHaveBeenCalledWith("ice-candidate", {
      to: "host-1",
      candidate: { candidate: "local" },
    });
  });

  it("guarda o stream remoto de cada participante", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));

    const remote = createFakeStream();
    await act(async () => {
      createdPeerConnections[0].ontrack?.({ streams: [remote] });
    });
    expect(result.current.participants[0].stream).toBe(remote);
  });

  it("remove e fecha a conexão de quem saiu", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));

    await act(async () => serverEmit("user-left", { peerId: "host-1" }));
    expect(result.current.participants).toEqual([]);
    expect(createdPeerConnections[0].close).toHaveBeenCalled();
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
});

describe("useWebRTC — encerramento", () => {
  it("endCall para os tracks e fecha todas as conexões", async () => {
    const stream = createFakeStream();
    stubGetUserMedia(async () => stream);

    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => {
      serverEmit("room-peers", {
        peers: [HOST_PEER, { peerId: "guest-2", role: "guest", name: "João" }],
      });
    });

    act(() => result.current.endCall());

    for (const track of stream.tracks) {
      expect(track.readyState).toBe("ended");
    }
    for (const pc of createdPeerConnections) {
      expect(pc.close).toHaveBeenCalled();
    }
    expect(result.current.localStream).toBeNull();
    expect(result.current.participants).toEqual([]);
  });

  it("host emite session-end ao encerrar", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.endCall());
    expect(socketMock.emit).toHaveBeenCalledWith("session-end");
  });

  it("guest não emite session-end ao sair", async () => {
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
  async function guestWithHost() {
    const onError = vi.fn();
    const hook = renderHook(() => useWebRTC({ ...GUEST_OPTS, onError }));
    await vi.waitFor(() => expect(hook.result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    return { ...hook, onError, pc: createdPeerConnections[0] };
  }

  it("marca 'connected' quando a conexão é estabelecida", async () => {
    const { result, pc } = await guestWithHost();
    await act(async () => pc.emitConnectionState("connected"));
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.participants[0].connectionState).toBe("connected");
  });

  it("entra em 'reconnecting' na primeira falha, sem desistir", async () => {
    const { result, pc } = await guestWithHost();
    await act(async () => pc.emitConnectionState("failed"));
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("quem fez a offer reinicia o ICE após uma falha", async () => {
    vi.useFakeTimers();
    const { pc } = await guestWithHost();
    pc.createOffer.mockClear();

    await act(async () => {
      pc.emitConnectionState("failed");
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    vi.useRealTimers();
  });

  it("desiste com 'failed' e onError após 3 tentativas", async () => {
    vi.useFakeTimers();
    const { result, pc, onError } = await guestWithHost();

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
