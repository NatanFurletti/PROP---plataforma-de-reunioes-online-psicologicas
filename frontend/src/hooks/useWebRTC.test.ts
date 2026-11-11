import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  createFakeStream,
  createFakeTrack,
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
  connect: vi.fn(),
  connected: false,
  recovered: false,
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
  socketMock.connect.mockClear();
  socketMock.connected = false;
  socketMock.recovered = false;
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

  it("guest guarda a chave recebida já na sala de espera", async () => {
    const onAdmissionKey = vi.fn();
    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onAdmissionKey }));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("waiting-for-approval", { admissionKey: "key-1" }));
    expect(onAdmissionKey).toHaveBeenCalledWith("key-1");

    // A aprovação traz a mesma chave: não salva de novo
    await act(async () => serverEmit("admitted", { admissionKey: "key-1" }));
    expect(onAdmissionKey).toHaveBeenCalledTimes(1);
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

describe("useWebRTC — volta do segundo plano", () => {
  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  }

  async function goForeground() {
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  beforeEach(() => setVisibility("visible"));

  it("socket recuperado mantém as conexões P2P", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("connect"));
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    const pc = createdPeerConnections[0];

    socketMock.recovered = true;
    await act(async () => serverEmit("connect"));

    expect(pc.close).not.toHaveBeenCalled();
    expect(result.current.participants).toHaveLength(1);
    expect(result.current.admissionStatus).toBe("admitted");
    expect(socketMock.emit.mock.calls.filter(([e]) => e === "join-room")).toHaveLength(2);
  });

  it("reconexão sem recuperação descarta as conexões antigas", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("connect"));
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    const pc = createdPeerConnections[0];

    await act(async () => serverEmit("connect"));

    expect(pc.close).toHaveBeenCalled();
    expect(result.current.admissionStatus).toBe("pending");
  });

  it("reconecta o socket na hora ao voltar a ficar visível", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await goForeground();
    expect(socketMock.connect).toHaveBeenCalled();
  });

  it("quem fez a offer reinicia o ICE de conexão caída ao voltar", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    const pc = createdPeerConnections[0];
    pc.connectionState = "failed";
    pc.createOffer.mockClear();

    await goForeground();
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
  });

  it("quem recebeu a offer pede o ICE restart ao outro lado", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () =>
      serverEmit("offer", { from: "guest-1", offer: { type: "offer", sdp: "x" } }),
    );
    createdPeerConnections[0].connectionState = "disconnected";

    await goForeground();
    expect(socketMock.emit).toHaveBeenCalledWith("restart-ice", { to: "guest-1" });
  });

  it("atende ao pedido de restart-ice quando é quem fez a offer", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    const pc = createdPeerConnections[0];
    pc.createOffer.mockClear();

    await act(async () => serverEmit("restart-ice", { from: HOST_PEER.peerId }));
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
  });

  it("recaptura a câmera encerrada pelo sistema e troca o track na conexão", async () => {
    const original = createFakeStream();
    const getUserMedia = stubGetUserMedia(async () => original);
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));

    // Câmera desligada pelo usuário e depois encerrada pelo sistema
    act(() => result.current.toggleCamera());
    const oldVideo = original.tracks[1];
    oldVideo.readyState = "ended";

    const newVideo = createFakeTrack("video");
    getUserMedia.mockImplementationOnce(async () => createFakeStream([newVideo]));

    await goForeground();

    await waitFor(() => expect(result.current.localStream).not.toBe(original));
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: expect.anything() });
    const sender = createdPeerConnections[0].getSenders().find((s) => s.track?.kind === "video");
    expect(sender?.replaceTrack).toHaveBeenCalledWith(newVideo);
    expect(newVideo.enabled).toBe(false);
    expect(result.current.localStream?.getTracks()).toEqual([original.tracks[0], newVideo]);
  });
});

describe("useWebRTC — câmera indisponível", () => {
  function audioOnlyStream() {
    return createFakeStream([createFakeTrack("audio")]);
  }

  it("entra só com áudio quando a câmera está ocupada", async () => {
    const getUserMedia = stubGetUserMedia(async () => {
      throw Object.assign(new Error("Could not start video source"), {
        name: "NotReadableError",
      });
    });
    getUserMedia
      .mockImplementationOnce(async () => {
        throw new Error("Could not start video source");
      })
      .mockImplementationOnce(async () => audioOnlyStream());
    const onError = vi.fn();

    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onError }));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
    expect(result.current.connectionState).not.toBe("failed");
    expect(result.current.isCameraOff).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/audio only/) }),
    );

    // Reserva o canal de vídeo para ligar a câmera depois sem renegociar
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    expect(createdPeerConnections[0].addTransceiver).toHaveBeenCalledWith(
      "video",
      expect.objectContaining({ direction: "sendrecv" }),
    );
  });

  it("tenta a câmera de novo quando ela ainda estava sendo liberada", async () => {
    const full = createFakeStream([createFakeTrack("audio"), createFakeTrack("video")]);
    const getUserMedia = stubGetUserMedia(async () => full);
    getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Could not start video source"), {
        name: "NotReadableError",
      });
    });
    const onError = vi.fn();

    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onError }));
    await waitFor(() => expect(result.current.localStream).toBe(full), { timeout: 3000 });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.isCameraOff).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("informa o motivo real quando a câmera foi bloqueada", async () => {
    const getUserMedia = stubGetUserMedia(async () => audioOnlyStream());
    getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    });
    const onError = vi.fn();

    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onError }));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "NotAllowedError", message: expect.stringMatching(/audio only/) }),
    );
  });

  it("falha só quando nem o áudio funciona", async () => {
    stubGetUserMedia(async () => {
      throw new Error("Permission denied");
    });
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.connectionState).toBe("failed"));
  });

  it("toggleCamera liga a câmera depois e envia pelo canal reservado", async () => {
    const getUserMedia = stubGetUserMedia(async () => audioOnlyStream());
    getUserMedia.mockImplementationOnce(async () => {
      throw new Error("Could not start video source");
    });
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));

    const video = createFakeTrack("video");
    getUserMedia.mockImplementationOnce(async () => createFakeStream([video]));
    await act(async () => result.current.toggleCamera());

    await waitFor(() => expect(result.current.isCameraOff).toBe(false));
    const transceiver = createdPeerConnections[0].getTransceivers()[0];
    expect(transceiver.sender.replaceTrack).toHaveBeenCalledWith(video);
    expect(result.current.localStream?.getVideoTracks()).toEqual([video]);
  });

  it("quem responde sem câmera deixa o canal de vídeo como sendrecv", async () => {
    stubGetUserMedia(async () => audioOnlyStream());
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    // Simula o transceiver criado pela offer remota sem track local
    await act(async () =>
      serverEmit("offer", { from: "guest-1", offer: { type: "offer", sdp: "x" } }),
    );
    const pc = createdPeerConnections[0];
    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
    await act(async () =>
      serverEmit("offer", { from: "guest-1", offer: { type: "offer", sdp: "y" } }),
    );
    expect(transceiver.direction).toBe("sendrecv");
  });

  it("junta track sem stream ao áudio que já chegou", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    const pc = createdPeerConnections[0];

    const audio = createFakeTrack("audio");
    const video = createFakeTrack("video");
    await act(async () =>
      pc.ontrack?.({ track: audio, streams: [createFakeStream([audio])] }),
    );
    await act(async () => pc.ontrack?.({ track: video, streams: [] }));

    expect(result.current.participants[0].stream?.getTracks()).toEqual([audio, video]);
  });
});

describe("useWebRTC — conexão substituída", () => {
  it("para de reconectar e avisa quando outra aba assume a sessão", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onError }));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));

    await act(async () => serverEmit("session-replaced"));
    expect(result.current.participants).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/another tab/) }),
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(socketMock.connect).not.toHaveBeenCalled();
  });
});

describe("useWebRTC — vídeo parado do par", () => {
  async function guestWithHost() {
    const hook = renderHook(() => useWebRTC(GUEST_OPTS));
    await vi.waitFor(() => expect(hook.result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("room-peers", { peers: [HOST_PEER] }));
    return { ...hook, pc: createdPeerConnections[0] };
  }

  it("marca o vídeo como chegando e depois parado quando os quadros param", async () => {
    vi.useFakeTimers();
    const { result, pc } = await guestWithHost();
    expect(result.current.participants[0].isVideoFlowing).toBe(false);

    // Quadros chegando a cada checagem
    for (let i = 0; i < 2; i++) {
      pc.framesDecoded += 30;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(result.current.participants[0].isVideoFlowing).toBe(true);

    // O par caiu / foi para o segundo plano: nenhum quadro novo
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(result.current.participants[0].isVideoFlowing).toBe(false);

    // Voltou
    pc.framesDecoded += 30;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.participants[0].isVideoFlowing).toBe(true);
    vi.useRealTimers();
  });
});

describe("useWebRTC — microfone dos participantes", () => {
  it("toggleMic avisa o servidor do novo estado", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.toggleMic());
    expect(socketMock.emit).toHaveBeenCalledWith("mic-state", { muted: true });
    act(() => result.current.toggleMic());
    expect(socketMock.emit).toHaveBeenCalledWith("mic-state", { muted: false });
  });

  it("mostra o mudo de quem já estava e de quem entra", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () =>
      serverEmit("room-peers", { peers: [{ ...HOST_PEER, micMuted: true }] }),
    );
    await act(async () =>
      serverEmit("user-joined", { peerId: "guest-2", role: "guest", name: "João", micMuted: false }),
    );

    const byId = (id: string) => result.current.participants.find((p) => p.peerId === id);
    expect(byId("host-1")?.isMicMuted).toBe(true);
    expect(byId("guest-2")?.isMicMuted).toBe(false);

    await act(async () => serverEmit("peer-mic-state", { peerId: "guest-2", muted: true }));
    expect(byId("guest-2")?.isMicMuted).toBe(true);
    await act(async () => serverEmit("peer-mic-state", { peerId: "host-1", muted: false }));
    expect(byId("host-1")?.isMicMuted).toBe(false);
  });

  it("peer-mic-state de quem não está na chamada é ignorado", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("peer-mic-state", { peerId: "ghost", muted: true }));
    expect(result.current.participants).toHaveLength(0);
  });

  it("force-muted desliga o microfone local e avisa", async () => {
    const stream = createFakeStream();
    stubGetUserMedia(async () => stream);
    const onForceMuted = vi.fn();
    const { result } = renderHook(() => useWebRTC({ ...GUEST_OPTS, onForceMuted }));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("force-muted"));

    expect(result.current.isMicMuted).toBe(true);
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
    expect(onForceMuted).toHaveBeenCalledTimes(1);

    // Só a própria pessoa religa
    act(() => result.current.toggleMic());
    expect(result.current.isMicMuted).toBe(false);
    expect(stream.getAudioTracks()[0].enabled).toBe(true);
  });

  it("host muta um participante", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("user-joined", GUEST_PEER));

    act(() => result.current.muteParticipant("guest-1"));

    expect(socketMock.emit).toHaveBeenCalledWith("mute-participant", { peerId: "guest-1" });
    expect(result.current.participants[0].isMicMuted).toBe(true);
  });

  it("paciente não emite mute-participant", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.muteParticipant("host-1"));
    expect(socketMock.emit).not.toHaveBeenCalledWith("mute-participant", expect.anything());
  });

  it("join-room leva o estado atual do microfone", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    act(() => result.current.toggleMic());

    socketMock.emit.mockClear();
    await act(async () => serverEmit("connect"));
    expect(socketMock.emit).toHaveBeenCalledWith("join-room", { micMuted: true, handRaised: false });
  });
});

describe("useWebRTC — levantar a mão", () => {
  it("toggleHand avisa o servidor e a posição vem do carimbo dele", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    act(() => result.current.toggleHand());
    expect(socketMock.emit).toHaveBeenCalledWith("raise-hand", { raised: true });
    expect(result.current.isHandRaised).toBe(true);
    expect(result.current.handRaisedAt).toBeNull();

    await act(async () => serverEmit("hand-state", { peerId: "socket-test", raisedAt: 100 }));
    expect(result.current.handRaisedAt).toBe(100);

    act(() => result.current.toggleHand());
    expect(socketMock.emit).toHaveBeenCalledWith("raise-hand", { raised: false });
    expect(result.current.isHandRaised).toBe(false);
    expect(result.current.handRaisedAt).toBeNull();
  });

  it("mostra a mão de quem já estava, de quem entra e as mudanças", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());

    await act(async () => serverEmit("user-joined", { ...GUEST_PEER, handRaisedAt: 50 }));
    await act(async () =>
      serverEmit("user-joined", { peerId: "guest-2", role: "guest", name: "João" }),
    );
    const byId = (id: string) => result.current.participants.find((p) => p.peerId === id);
    expect(byId("guest-1")?.handRaisedAt).toBe(50);
    expect(byId("guest-2")?.handRaisedAt).toBeNull();

    await act(async () => serverEmit("hand-state", { peerId: "guest-2", raisedAt: 60 }));
    expect(byId("guest-2")?.handRaisedAt).toBe(60);
  });

  it("host abaixa a mão de um paciente", async () => {
    const { result } = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    await act(async () => serverEmit("user-joined", { ...GUEST_PEER, handRaisedAt: 50 }));

    act(() => result.current.lowerHand("guest-1"));
    expect(socketMock.emit).toHaveBeenCalledWith("lower-hand", { peerId: "guest-1" });
    expect(result.current.participants[0].handRaisedAt).toBeNull();
  });

  it("psicólogo abaixando a mão do paciente desmarca o botão dele", async () => {
    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    act(() => result.current.toggleHand());
    await act(async () => serverEmit("hand-state", { peerId: "socket-test", raisedAt: 100 }));

    await act(async () => serverEmit("hand-state", { peerId: "socket-test", raisedAt: null }));
    expect(result.current.isHandRaised).toBe(false);
  });

  it("host não levanta a mão e join-room leva a mão levantada", async () => {
    const host = renderHook(() => useWebRTC(HOST_OPTS));
    await waitFor(() => expect(host.result.current.localStream).not.toBeNull());
    act(() => host.result.current.toggleHand());
    expect(socketMock.emit).not.toHaveBeenCalledWith("raise-hand", expect.anything());
    host.unmount();

    const { result } = renderHook(() => useWebRTC(GUEST_OPTS));
    await waitFor(() => expect(result.current.localStream).not.toBeNull());
    act(() => result.current.toggleHand());
    socketMock.emit.mockClear();
    await act(async () => serverEmit("connect"));
    expect(socketMock.emit).toHaveBeenCalledWith("join-room", { micMuted: false, handRaised: true });
  });
});
