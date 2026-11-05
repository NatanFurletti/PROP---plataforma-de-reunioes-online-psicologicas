import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Socket } from "socket.io-client";
import { useChat } from "./useChat";

type Ack = (err: Error | null, response?: unknown) => void;

// Socket falso: guarda os handlers e os envios com ack
function createFakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const sent: { event: string; payload: unknown; ack: Ack }[] = [];
  const socket = {
    on: vi.fn((event: string, cb: (payload: unknown) => void) => handlers.set(event, cb)),
    off: vi.fn((event: string) => handlers.delete(event)),
    timeout: vi.fn(() => ({
      emit: (event: string, payload: unknown, ack: Ack) => sent.push({ event, payload, ack }),
    })),
  };
  const receive = (payload: unknown) => handlers.get("chat-message")?.(payload);
  return { socket: socket as unknown as Socket, handlers, sent, receive };
}

const INCOMING = {
  id: "m1",
  from: "peer-1",
  senderName: "Maria",
  senderRole: "guest",
  sentAt: "2026-11-04T12:00:00.000Z",
  text: "oi",
};

const baseOptions = { enabled: true, isOpen: false, selfName: "Psicólogo", selfRole: "host" as const };

beforeEach(() => {
  let n = 0;
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:test-${++n}`),
    revokeObjectURL: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChat — recebimento", () => {
  it("adiciona mensagens recebidas e conta as não lidas com o painel fechado", () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));

    act(() => fake.receive(INCOMING));

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ mine: false, text: "oi", status: "sent" });
    expect(result.current.unreadCount).toBe(1);
  });

  it("zera as não lidas ao abrir e não conta com o painel aberto", () => {
    const fake = createFakeSocket();
    const { result, rerender } = renderHook(
      ({ isOpen }) => useChat({ ...baseOptions, isOpen, socket: fake.socket }),
      { initialProps: { isOpen: false } },
    );

    act(() => fake.receive(INCOMING));
    rerender({ isOpen: true });
    expect(result.current.unreadCount).toBe(0);

    act(() => fake.receive({ ...INCOMING, id: "m2" }));
    expect(result.current.unreadCount).toBe(0);
  });

  it("ignora mensagem repetida", () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    act(() => {
      fake.receive(INCOMING);
      fake.receive(INCOMING);
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it("cria URL local para o anexo com o tipo pela extensão", () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));

    act(() =>
      fake.receive({
        ...INCOMING,
        text: undefined,
        file: { name: "foto.png", type: "text/html", size: 3, data: new ArrayBuffer(3) },
      }),
    );

    expect(result.current.messages[0].file).toEqual({
      name: "foto.png",
      type: "image/png",
      size: 3,
      url: "blob:test-1",
    });
  });

  it("não escuta mensagens enquanto não está na chamada", () => {
    const fake = createFakeSocket();
    renderHook(() => useChat({ ...baseOptions, enabled: false, socket: fake.socket }));
    expect(fake.handlers.has("chat-message")).toBe(false);
  });

  it("libera as URLs dos anexos ao desmontar", () => {
    const fake = createFakeSocket();
    const { unmount } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    act(() =>
      fake.receive({ ...INCOMING, file: { name: "a.pdf", type: "", size: 1, data: new ArrayBuffer(1) } }),
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
  });
});

describe("useChat — envio", () => {
  it("mostra a mensagem como enviando e confirma com o id do servidor", async () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));

    let error: string | null = "x";
    await act(async () => {
      error = await result.current.sendMessage("  olá  ");
    });

    expect(error).toBeNull();
    expect(fake.sent[0]).toMatchObject({ event: "chat-message", payload: { text: "olá" } });
    expect(result.current.messages[0]).toMatchObject({ mine: true, text: "olá", status: "sending" });

    act(() => fake.sent[0].ack(null, { ok: true, id: "srv-1", sentAt: "2026-11-04T12:00:00Z" }));
    expect(result.current.messages[0]).toMatchObject({ id: "srv-1", status: "sent" });
  });

  it("marca como falha quando o servidor recusa", async () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    await act(async () => {
      await result.current.sendMessage("oi");
    });

    act(() => fake.sent[0].ack(null, { ok: false, error: "rate-limited" }));
    expect(result.current.messages[0].status).toBe("failed");
    expect(result.current.messages[0].error).toMatch(/Aguarde/);
  });

  it("marca como falha quando não há confirmação a tempo", async () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    await act(async () => {
      await result.current.sendMessage("oi");
    });

    act(() => fake.sent[0].ack(new Error("timeout")));
    expect(result.current.messages[0].error).toMatch(/conexão/);
  });

  it("envia o arquivo como binário", async () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    const file = new File(["%PDF-1.7"], "laudo.pdf", { type: "application/pdf" });

    await act(async () => {
      await result.current.sendMessage("", file);
    });

    await waitFor(() => expect(fake.sent).toHaveLength(1));
    const payload = fake.sent[0].payload as { text?: string; file: { name: string; data: ArrayBuffer } };
    expect(payload.text).toBeUndefined();
    expect(payload.file.name).toBe("laudo.pdf");
    expect(payload.file.data.byteLength).toBe(8);
    expect(result.current.messages[0].file).toMatchObject({ type: "application/pdf", url: "blob:test-1" });
  });

  it("recusa arquivo não permitido sem enviar", async () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    const file = new File(["<html>"], "pagina.html");

    let error: string | null = null;
    await act(async () => {
      error = await result.current.sendMessage("", file);
    });

    expect(error).toMatch(/não permitido/);
    expect(fake.sent).toHaveLength(0);
    expect(result.current.messages).toHaveLength(0);
  });

  it("não envia mensagem vazia", async () => {
    const fake = createFakeSocket();
    const { result } = renderHook(() => useChat({ ...baseOptions, socket: fake.socket }));
    await act(async () => {
      await result.current.sendMessage("   ");
    });
    expect(fake.sent).toHaveLength(0);
  });
});
