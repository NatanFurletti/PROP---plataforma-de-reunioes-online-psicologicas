import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1h";

const prismaMock = {
  psychologist: {
    findUnique: vi.fn(),
  },
  session: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock("../prismaClient", () => ({ prisma: prismaMock }));

const { registerSignalingHandlers } = await import("./signalingHandler");

const OWNER_ID = "psy-owner";
const SESSION_ID = "session-1";
const ACCESS_TOKEN = "guest-access-token";

// Sessão padrão retornada pelo mock do Prisma no handshake
function scheduledSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    psychologistId: OWNER_ID,
    accessToken: ACCESS_TOKEN,
    status: "SCHEDULED",
    scheduledAt: new Date(),
    durationMinutes: 50,
    ...overrides,
  };
}

// JWT válido para o psicólogo dono, com tokenVersion casando com o DB
function hostJwt(id = OWNER_ID, version = 0): string {
  return jwt.sign({ id, email: "owner@test.com", v: version }, "test-secret-do-not-use-in-prod");
}

let httpServer: HttpServer;
let io: Server;
let port: number;
const openClients: ClientSocket[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  // Por padrão o psicólogo dono existe com tokenVersion 0
  prismaMock.psychologist.findUnique.mockResolvedValue({
    id: OWNER_ID,
    email: "owner@test.com",
    tokenVersion: 0,
  });
  prismaMock.session.findUnique.mockResolvedValue(scheduledSession());
  prismaMock.session.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.session.update.mockResolvedValue({ id: SESSION_ID });

  httpServer = createServer();
  io = new Server(httpServer);
  registerSignalingHandlers(io, prismaMock as never);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  for (const client of openClients) client.disconnect();
  openClients.length = 0;
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

interface ConnectOptions {
  role: "host" | "guest";
  sessionId?: string;
  accessToken?: string;
  jwtCookie?: string;
}

// Cria um cliente Socket.IO com o handshake indicado (sem esperar conexão)
function makeClient({
  role,
  sessionId = SESSION_ID,
  accessToken,
  jwtCookie,
}: ConnectOptions): ClientSocket {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { sessionId, role, accessToken },
    extraHeaders: jwtCookie ? { cookie: `jwt=${jwtCookie}` } : {},
    transports: ["websocket"],
    reconnection: false,
  });
  openClients.push(client);
  return client;
}

// Resolve true se conectar, false (com a mensagem) se o handshake for rejeitado
function tryConnect(
  client: ClientSocket,
): Promise<{ connected: boolean; error?: string }> {
  return new Promise((resolve) => {
    client.on("connect", () => resolve({ connected: true }));
    client.on("connect_error", (err: Error) =>
      resolve({ connected: false, error: err.message }),
    );
  });
}

// Conecta e entra na sala, resolvendo quando o servidor confirmar o join
async function connectAndJoin(options: ConnectOptions): Promise<ClientSocket> {
  const client = makeClient(options);
  const result = await tryConnect(client);
  if (!result.connected) {
    throw new Error(`Handshake rejeitado: ${result.error}`);
  }
  client.emit("join-room");
  return client;
}

// Aguarda um evento com timeout; resolve null se não chegar
function waitFor<T = unknown>(
  client: ClientSocket,
  event: string,
  timeoutMs = 300,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe("signaling handshake — autenticação", () => {
  it("rejeita handshake sem sessionId", async () => {
    const client = makeClient({ role: "host", sessionId: "" });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/sessionId\/role required/);
  });

  it("rejeita role inválido", async () => {
    const client = makeClient({ role: "admin" as never });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/sessionId\/role required/);
  });

  it("rejeita sessão inexistente", async () => {
    prismaMock.session.findUnique.mockResolvedValue(null);
    const client = makeClient({ role: "guest", accessToken: ACCESS_TOKEN });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Session not found/);
  });

  it("rejeita sessão COMPLETED", async () => {
    prismaMock.session.findUnique.mockResolvedValue(
      scheduledSession({ status: "COMPLETED" }),
    );
    const client = makeClient({ role: "guest", accessToken: ACCESS_TOKEN });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/no longer available/);
  });

  it("rejeita sessão CANCELLED", async () => {
    prismaMock.session.findUnique.mockResolvedValue(
      scheduledSession({ status: "CANCELLED" }),
    );
    const client = makeClient({ role: "guest", accessToken: ACCESS_TOKEN });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/no longer available/);
  });

  it("rejeita host sem cookie JWT", async () => {
    const client = makeClient({ role: "host" });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Missing auth cookie/);
  });

  it("rejeita host com JWT malformado", async () => {
    const client = makeClient({ role: "host", jwtCookie: "not-a-jwt" });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid auth token/);
  });

  it("rejeita host cujo JWT pertence a outro psicólogo", async () => {
    // JWT válido, mas de um psicólogo que não é dono da sessão
    prismaMock.psychologist.findUnique.mockResolvedValue({
      id: "psy-intruder",
      email: "intruder@test.com",
      tokenVersion: 0,
    });
    const client = makeClient({
      role: "host",
      jwtCookie: hostJwt("psy-intruder"),
    });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/not the session owner/);
  });

  it("rejeita host com token revogado (tokenVersion divergente)", async () => {
    // JWT emitido com v=0, mas o DB já incrementou para 1 (logout)
    prismaMock.psychologist.findUnique.mockResolvedValue({
      id: OWNER_ID,
      email: "owner@test.com",
      tokenVersion: 1,
    });
    const client = makeClient({ role: "host", jwtCookie: hostJwt(OWNER_ID, 0) });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid auth token/);
  });

  it("aceita host com JWT válido do dono", async () => {
    const client = makeClient({ role: "host", jwtCookie: hostJwt() });
    const result = await tryConnect(client);
    expect(result.connected).toBe(true);
  });

  it("rejeita guest com accessToken incorreto", async () => {
    const client = makeClient({ role: "guest", accessToken: "wrong-token" });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid access token/);
  });

  it("rejeita guest sem accessToken", async () => {
    const client = makeClient({ role: "guest" });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid access token/);
  });

  it("aceita guest com accessToken correto", async () => {
    const client = makeClient({ role: "guest", accessToken: ACCESS_TOKEN });
    const result = await tryConnect(client);
    expect(result.connected).toBe(true);
  });
});

describe("signaling — ocupação da sala", () => {
  it("notifica o host quando o guest entra", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const joined = waitFor<{ role: string }>(host, "user-joined");
    await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    expect(await joined).toEqual({ role: "guest" });
  });

  it("marca a sessão como IN_PROGRESS quando o host entra", async () => {
    await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    // updateMany é assíncrono dentro do handler — aguardar propagação
    await new Promise((r) => setTimeout(r, 100));
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: "SCHEDULED" },
      data: expect.objectContaining({ status: "IN_PROGRESS" }),
    });
  });

  it("rejeita um segundo host na mesma sala", async () => {
    await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const second = makeClient({ role: "host", jwtCookie: hostJwt() });
    await tryConnect(second);
    const roomFull = waitFor<{ error: string }>(second, "room-full");
    second.emit("join-room");
    const payload = await roomFull;
    expect(payload?.error).toMatch(/host is already connected/);
  });

  it("rejeita um terceiro participante com room-full", async () => {
    await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });

    const third = makeClient({ role: "guest", accessToken: ACCESS_TOKEN });
    await tryConnect(third);
    const roomFull = waitFor<{ error: string }>(third, "room-full");
    third.emit("join-room");
    const payload = await roomFull;
    expect(payload?.error).toMatch(/2 participants/);
  });

  it("emite user-left ao par restante quando alguém desconecta", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const guest = await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
    });
    await waitFor(host, "user-joined");

    const left = waitFor(host, "user-left");
    guest.disconnect();
    expect(await left).not.toBeNull();
  });
});

describe("signaling — encaminhamento de mensagens", () => {
  it("encaminha offer do host para o guest", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const guest = await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
    });
    await waitFor(host, "user-joined");

    const received = waitFor<{ offer: unknown }>(guest, "offer");
    host.emit("offer", { offer: { type: "offer", sdp: "fake-sdp" } });
    expect(await received).toEqual({
      offer: { type: "offer", sdp: "fake-sdp" },
    });
  });

  it("encaminha answer do guest para o host", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const guest = await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
    });
    await waitFor(host, "user-joined");

    const received = waitFor<{ answer: unknown }>(host, "answer");
    guest.emit("answer", { answer: { type: "answer", sdp: "fake-sdp" } });
    expect(await received).toEqual({
      answer: { type: "answer", sdp: "fake-sdp" },
    });
  });

  it("encaminha ice-candidate para o outro participante", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const guest = await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
    });
    await waitFor(host, "user-joined");

    const received = waitFor<{ candidate: unknown }>(guest, "ice-candidate");
    host.emit("ice-candidate", { candidate: { candidate: "fake-candidate" } });
    expect(await received).toEqual({
      candidate: { candidate: "fake-candidate" },
    });
  });

  it("não devolve a própria offer ao remetente", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    await waitFor(host, "user-joined");

    const echoed = waitFor(host, "offer");
    host.emit("offer", { offer: { type: "offer", sdp: "fake-sdp" } });
    expect(await echoed).toBeNull();
  });
});

describe("signaling — encerramento de sessão", () => {
  it("host encerra: emite session-ended e marca COMPLETED", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const guest = await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
    });
    await waitFor(host, "user-joined");

    const ended = waitFor(guest, "session-ended");
    host.emit("session-end");
    expect(await ended).not.toBeNull();

    await new Promise((r) => setTimeout(r, 100));
    expect(prismaMock.session.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("guest não pode encerrar a sessão", async () => {
    const host = await connectAndJoin({ role: "host", jwtCookie: hostJwt() });
    const guest = await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
    });
    await waitFor(host, "user-joined");

    const ended = waitFor(host, "session-ended");
    guest.emit("session-end");

    expect(await ended).toBeNull();
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });
});
