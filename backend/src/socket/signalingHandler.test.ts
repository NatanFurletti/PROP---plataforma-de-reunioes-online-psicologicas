import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1h";
// Limite baixo para testar a sala cheia sem abrir muitos clientes
process.env.MAX_ROOM_PARTICIPANTS = "3";

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

const { registerSignalingHandlers, __resetRooms } = await import(
  "./signalingHandler"
);

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
  __resetRooms();
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
  name?: string;
  admissionKey?: string;
}

// Cria um cliente Socket.IO com o handshake indicado (sem esperar conexão)
function makeClient({
  role,
  sessionId = SESSION_ID,
  accessToken,
  jwtCookie,
  name = "Maria",
  admissionKey,
}: ConnectOptions): ClientSocket {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { sessionId, role, accessToken, name, admissionKey },
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


describe("signaling handshake — nome do paciente", () => {
  it("rejeita guest sem nome", async () => {
    const client = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      name: "   ",
    });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid name/);
  });

  it("rejeita nome longo demais", async () => {
    const client = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      name: "a".repeat(61),
    });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid name/);
  });
});

interface PeerInfo {
  peerId: string;
  role: string;
  name: string;
}

async function connectHost(): Promise<ClientSocket> {
  const host = makeClient({ role: "host", jwtCookie: hostJwt() });
  await tryConnect(host);
  const peers = waitFor(host, "room-peers");
  host.emit("join-room");
  await peers;
  return host;
}

// Paciente entra e é admitido pelo host; resolve com o socket já na chamada
async function joinAndAdmit(
  host: ClientSocket,
  name = "Maria",
): Promise<{ guest: ClientSocket; peers: PeerInfo[]; admissionKey: string }> {
  const request = waitFor<{ guestId: string; name: string }>(host, "guest-waiting");
  const guest = await connectAndJoin({
    role: "guest",
    accessToken: ACCESS_TOKEN,
    name,
  });
  const { guestId } = (await request)!;

  const admitted = waitFor<{ admissionKey: string }>(guest, "admitted");
  const roomPeers = waitFor<{ peers: PeerInfo[] }>(guest, "room-peers");
  host.emit("admit-guest", { guestId });
  const { admissionKey } = (await admitted)!;
  const { peers } = (await roomPeers)!;
  return { guest, peers, admissionKey };
}

describe("signaling — sala de espera e aprovação", () => {
  it("paciente fica aguardando e o host recebe o pedido com o nome", async () => {
    const host = await connectHost();
    const request = waitFor<{ guestId: string; name: string }>(host, "guest-waiting");

    const guest = makeClient({ role: "guest", accessToken: ACCESS_TOKEN, name: "Maria" });
    await tryConnect(guest);
    const waiting = new Promise<boolean>((resolve) => {
      guest.once("waiting-for-approval", () => resolve(true));
      setTimeout(() => resolve(false), 300);
    });
    guest.emit("join-room");

    expect(await waiting).toBe(true);
    expect(await request).toEqual({ guestId: guest.id, name: "Maria" });
  });

  it("paciente que chega antes do host aparece na lista ao host entrar", async () => {
    const guest = makeClient({ role: "guest", accessToken: ACCESS_TOKEN, name: "João" });
    await tryConnect(guest);
    guest.emit("join-room");
    await new Promise((r) => setTimeout(r, 50));

    const host = makeClient({ role: "host", jwtCookie: hostJwt() });
    await tryConnect(host);
    const list = waitFor<{ guests: unknown[] }>(host, "waiting-list");
    host.emit("join-room");

    expect(await list).toEqual({ guests: [{ guestId: guest.id, name: "João" }] });
  });

  it("host admite: paciente recebe a chave e a lista de pares", async () => {
    const host = await connectHost();
    const joined = waitFor<PeerInfo>(host, "user-joined", 1000);
    const { guest, peers, admissionKey } = await joinAndAdmit(host);

    expect(admissionKey).toEqual(expect.any(String));
    expect(peers).toEqual([{ peerId: host.id, role: "host", name: "Psicólogo" }]);
    expect(await joined).toEqual({ peerId: guest.id, role: "guest", name: "Maria" });
  });

  it("host recusa: paciente recebe admission-denied e não entra", async () => {
    const host = await connectHost();
    const request = waitFor<{ guestId: string }>(host, "guest-waiting");
    const guest = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    const { guestId } = (await request)!;

    const denied = new Promise<boolean>((resolve) => {
      guest.once("admission-denied", () => resolve(true));
      setTimeout(() => resolve(false), 300);
    });
    const peers = waitFor(guest, "room-peers");
    host.emit("deny-guest", { guestId });

    expect(await denied).toBe(true);
    expect(await peers).toBeNull();
  });

  it("paciente não pode admitir outro paciente", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host, "Maria");

    const request = waitFor<{ guestId: string }>(host, "guest-waiting");
    const other = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN, name: "Intruso" });
    const { guestId } = (await request)!;

    const admitted = waitFor(other, "admitted");
    guest.emit("admit-guest", { guestId });
    expect(await admitted).toBeNull();
  });

  it("paciente em espera não consegue enviar sinalização ao host", async () => {
    const host = await connectHost();
    const request = waitFor(host, "guest-waiting");
    const guest = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    await request;

    const received = waitFor(host, "offer");
    guest.emit("offer", { to: host.id, offer: { type: "offer", sdp: "x" } });
    expect(await received).toBeNull();
  });

  it("host recebe a lista atualizada quando quem aguardava desiste", async () => {
    const host = await connectHost();
    const request = waitFor(host, "guest-waiting");
    const guest = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    await request;

    const list = waitFor<{ guests: unknown[] }>(host, "waiting-list");
    guest.disconnect();
    expect(await list).toEqual({ guests: [] });
  });

  it("paciente aprovado volta com a chave sem nova aprovação", async () => {
    const host = await connectHost();
    const { guest, admissionKey } = await joinAndAdmit(host);
    const left = waitFor(host, "user-left");
    guest.disconnect();
    await left;

    const back = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      admissionKey,
    });
    await tryConnect(back);
    const peers = waitFor<{ peers: PeerInfo[] }>(back, "room-peers");
    back.emit("join-room");
    expect((await peers)?.peers).toHaveLength(1);
  });

  it("chave de reentrada inventada não pula a aprovação", async () => {
    await connectHost();
    const guest = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      admissionKey: "chave-falsa",
    });
    await tryConnect(guest);
    const peers = waitFor(guest, "room-peers");
    const waiting = new Promise<boolean>((resolve) => {
      guest.once("waiting-for-approval", () => resolve(true));
      setTimeout(() => resolve(false), 300);
    });
    guest.emit("join-room");
    expect(await waiting).toBe(true);
    expect(await peers).toBeNull();
  });
});

describe("signaling — vários participantes", () => {
  it("permite mais de um paciente na mesma chamada", async () => {
    const host = await connectHost();
    const first = await joinAndAdmit(host, "Maria");
    const firstNotified = waitFor<PeerInfo>(first.guest, "user-joined", 1000);
    const second = await joinAndAdmit(host, "João");

    expect(second.peers.map((p) => p.name).sort()).toEqual(["Maria", "Psicólogo"]);
    expect(await firstNotified).toEqual({
      peerId: second.guest.id,
      role: "guest",
      name: "João",
    });
  });

  it("recusa admitir além do limite da sala", async () => {
    // Limite de teste: 3 (host + 2 pacientes)
    const host = await connectHost();
    await joinAndAdmit(host, "Maria");
    await joinAndAdmit(host, "João");

    const request = waitFor<{ guestId: string }>(host, "guest-waiting");
    const extra = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN, name: "Ana" });
    const { guestId } = (await request)!;

    const error = waitFor<{ error: string }>(host, "admission-error");
    const admitted = waitFor(extra, "admitted");
    host.emit("admit-guest", { guestId });

    expect((await error)?.error).toMatch(/full/);
    expect(await admitted).toBeNull();
  });

  it("rejeita um segundo host na mesma sala", async () => {
    await connectHost();
    const second = makeClient({ role: "host", jwtCookie: hostJwt() });
    await tryConnect(second);
    const roomFull = waitFor<{ error: string }>(second, "room-full");
    second.emit("join-room");
    expect((await roomFull)?.error).toMatch(/host is already connected/);
  });

  it("marca a sessão como IN_PROGRESS quando o host entra", async () => {
    await connectHost();
    await new Promise((r) => setTimeout(r, 100));
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: "SCHEDULED" },
      data: expect.objectContaining({ status: "IN_PROGRESS" }),
    });
  });

  it("emite user-left com o peerId de quem saiu", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const guestId = guest.id;

    const left = waitFor<{ peerId: string }>(host, "user-left");
    guest.disconnect();
    expect(await left).toEqual({ peerId: guestId });
  });
});

describe("signaling — encaminhamento entre pares", () => {
  it("encaminha offer só para o destinatário, com o remetente", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");

    const toMaria = waitFor(maria.guest, "offer");
    const toJoao = waitFor(joao.guest, "offer");
    host.emit("offer", { to: maria.guest.id, offer: { type: "offer", sdp: "sdp" } });

    expect(await toMaria).toEqual({ from: host.id, offer: { type: "offer", sdp: "sdp" } });
    expect(await toJoao).toBeNull();
  });

  it("encaminha answer ao destinatário", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const received = waitFor(host, "answer");
    guest.emit("answer", { to: host.id, answer: { type: "answer", sdp: "sdp" } });
    expect(await received).toEqual({ from: guest.id, answer: { type: "answer", sdp: "sdp" } });
  });

  it("encaminha ice-candidate ao destinatário", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const received = waitFor(guest, "ice-candidate");
    host.emit("ice-candidate", { to: guest.id, candidate: { candidate: "c" } });
    expect(await received).toEqual({ from: host.id, candidate: { candidate: "c" } });
  });

  it("não encaminha para quem não está na chamada", async () => {
    const host = await connectHost();
    const request = waitFor<{ guestId: string }>(host, "guest-waiting");
    const waitingGuest = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    await request;

    const received = waitFor(waitingGuest, "offer");
    host.emit("offer", { to: waitingGuest.id, offer: { type: "offer", sdp: "x" } });
    expect(await received).toBeNull();
  });
});

describe("signaling — encerramento de sessão", () => {
  it("host encerra: avisa participantes e quem aguardava, e marca COMPLETED", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const request = waitFor(host, "guest-waiting");
    const waitingGuest = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN, name: "Ana" });
    await request;

    const ended = (client: ClientSocket) =>
      new Promise<boolean>((resolve) => {
        client.once("session-ended", () => resolve(true));
        setTimeout(() => resolve(false), 500);
      });
    const endedGuest = ended(guest);
    const endedWaiting = ended(waitingGuest);
    const acked = new Promise<boolean>((resolve) => {
      host.emit("session-end", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });

    expect(await endedGuest).toBe(true);
    expect(await endedWaiting).toBe(true);
    expect(await acked).toBe(true);
    expect(prismaMock.session.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("paciente não pode encerrar a sessão", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const ended = waitFor(host, "session-ended");
    guest.emit("session-end");

    expect(await ended).toBeNull();
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });
});
