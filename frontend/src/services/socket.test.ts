import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cada chamada a `io()` devolve um socket falso rastreável
const created: Array<{ close: ReturnType<typeof vi.fn>; auth: unknown }> = [];

vi.mock("socket.io-client", () => ({
  io: vi.fn((_url: string, opts: { auth: unknown }) => {
    const socket = {
      auth: opts.auth,
      close: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
      connected: false,
      id: `socket-${created.length}`,
    };
    created.push(socket);
    return socket;
  }),
}));

const { initializeSocket, getSocket, closeSocket } = await import("./socket");

const HOST_AUTH = { sessionId: "s1", role: "host" as const };
const GUEST_AUTH = {
  sessionId: "s1",
  role: "guest" as const,
  accessToken: "tok",
};

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  closeSocket();
});

describe("initializeSocket", () => {
  it("cria um socket com o auth informado", () => {
    const socket = initializeSocket(HOST_AUTH);
    expect(created).toHaveLength(1);
    expect(socket.auth).toEqual(HOST_AUTH);
  });

  it("reutiliza o socket quando o auth é o mesmo", () => {
    const first = initializeSocket(HOST_AUTH);
    const second = initializeSocket({ ...HOST_AUTH });

    // Repetir o mesmo handshake não pode derrubar a conexão existente:
    // useWebRTC chama isso a cada candidato ICE.
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
  });

  it("recria o socket quando o auth muda", () => {
    const first = initializeSocket(HOST_AUTH);
    const second = initializeSocket(GUEST_AUTH);

    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
    expect(first.close).toHaveBeenCalled();
  });

  it("recria o socket quando apenas o accessToken muda", () => {
    initializeSocket(GUEST_AUTH);
    initializeSocket({ ...GUEST_AUTH, accessToken: "outro-token" });
    expect(created).toHaveLength(2);
  });

  it("recria o socket quando apenas o sessionId muda", () => {
    initializeSocket(HOST_AUTH);
    initializeSocket({ ...HOST_AUTH, sessionId: "s2" });
    expect(created).toHaveLength(2);
  });
});

describe("getSocket", () => {
  it("lança erro se o socket não foi inicializado", () => {
    expect(() => getSocket()).toThrow(/not initialized/i);
  });

  it("devolve a instância ativa", () => {
    const socket = initializeSocket(HOST_AUTH);
    expect(getSocket()).toBe(socket);
  });
});

describe("closeSocket", () => {
  it("fecha e limpa a instância", () => {
    const socket = initializeSocket(HOST_AUTH);
    closeSocket();
    expect(socket.close).toHaveBeenCalled();
    expect(() => getSocket()).toThrow();
  });

  it("é seguro chamar sem socket ativo", () => {
    expect(() => closeSocket()).not.toThrow();
  });
});
