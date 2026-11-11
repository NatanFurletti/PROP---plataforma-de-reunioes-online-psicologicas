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
// Tolerância curta para testar a remoção de quem caiu sem sair
process.env.RECONNECT_GRACE_MS = "400";

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

const { MAX_SOCKET_PAYLOAD_BYTES } = await import("./chat");
const { registerSignalingHandlers, __resetRooms, CONNECTION_STATE_RECOVERY } = await import(
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
  io = new Server(httpServer, {
    connectionStateRecovery: CONNECTION_STATE_RECOVERY,
    maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
  });
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
  hostToken?: string;
}

// Cria um cliente Socket.IO com o handshake indicado (sem esperar conexão)
function makeClient({
  role,
  sessionId = SESSION_ID,
  accessToken,
  jwtCookie,
  name = "Maria",
  admissionKey,
  hostToken,
}: ConnectOptions): ClientSocket {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { sessionId, role, accessToken, name, admissionKey, hostToken },
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


// Token curto de socket do host, como emitido por POST /sessions/:id/socket-token
function hostSocketToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { pid: OWNER_ID, sid: SESSION_ID, v: 0, purpose: "host-socket", ...overrides },
    "test-secret-do-not-use-in-prod",
    { expiresIn: "5m" },
  );
}

describe("signaling handshake — token de socket do host", () => {
  it("aceita host com token de socket válido, sem cookie", async () => {
    const client = makeClient({ role: "host", hostToken: hostSocketToken() });
    expect((await tryConnect(client)).connected).toBe(true);
  });

  it("rejeita token emitido para outra sessão", async () => {
    const client = makeClient({
      role: "host",
      hostToken: hostSocketToken({ sid: "outra-sessao" }),
    });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid auth token/);
  });

  it("rejeita token revogado pelo logout (tokenVersion)", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue({
      id: OWNER_ID,
      email: "owner@test.com",
      tokenVersion: 1,
    });
    const client = makeClient({ role: "host", hostToken: hostSocketToken() });
    expect((await tryConnect(client)).connected).toBe(false);
  });

  it("rejeita o JWT de login usado como token de socket", async () => {
    const client = makeClient({ role: "host", hostToken: hostJwt() });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/Invalid auth token/);
  });

  it("rejeita token de socket de outro psicólogo", async () => {
    const client = makeClient({
      role: "host",
      hostToken: hostSocketToken({ pid: "psy-intruder" }),
    });
    const result = await tryConnect(client);
    expect(result.connected).toBe(false);
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
    expect(peers).toEqual([{ peerId: host.id, role: "host", name: "Psicólogo", micMuted: false, handRaisedAt: null }]);
    expect(await joined).toEqual({ peerId: guest.id, role: "guest", name: "Maria", micMuted: false, handRaisedAt: null });
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

describe("signaling — mesmo paciente voltando pelo link", () => {
  // Pede entrada e resolve com a chave recebida na sala de espera
  async function requestEntry(
    options: Partial<ConnectOptions> = {},
  ): Promise<{ guest: ClientSocket; admissionKey: string }> {
    const guest = makeClient({ role: "guest", accessToken: ACCESS_TOKEN, ...options });
    await tryConnect(guest);
    const waiting = waitFor<{ admissionKey: string }>(guest, "waiting-for-approval");
    guest.emit("join-room");
    const payload = await waiting;
    if (!payload) throw new Error("Paciente não entrou na espera");
    return { guest, admissionKey: payload.admissionKey };
  }

  it("a chave chega já na sala de espera e é a mesma depois da aprovação", async () => {
    const host = await connectHost();
    const request = waitFor<{ guestId: string }>(host, "guest-waiting");
    const { guest, admissionKey } = await requestEntry();
    expect(admissionKey).toEqual(expect.any(String));

    const admitted = waitFor<{ admissionKey: string }>(guest, "admitted");
    host.emit("admit-guest", { guestId: (await request)!.guestId });
    expect((await admitted)?.admissionKey).toBe(admissionKey);
  });

  it("voltar com a chave mantém o nome do primeiro pedido", async () => {
    const host = await connectHost();
    const { guest, admissionKey } = await joinAndAdmit(host, "Maria");
    const left = waitFor(host, "user-left");
    guest.disconnect();
    await left;

    const joined = waitFor<PeerInfo>(host, "user-joined", 1000);
    await connectAndJoin({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      name: "Outro Nome",
      admissionKey,
    });
    expect((await joined)?.name).toBe("Maria");
  });

  it("novo pedido do mesmo paciente substitui o anterior na espera", async () => {
    const host = await connectHost();
    const first = await requestEntry({ name: "Maria" });

    const replaced = waitFor(first.guest, "session-replaced");
    const list = waitFor<{ guests: { guestId: string; name: string }[] }>(
      host,
      "waiting-list",
    );
    const second = await requestEntry({
      name: "Maria 2",
      admissionKey: first.admissionKey,
    });

    expect(await replaced).not.toBeNull();
    expect(second.admissionKey).toBe(first.admissionKey);
    expect((await list)?.guests).toEqual([{ guestId: second.guest.id, name: "Maria" }]);
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
      micMuted: false,
      handRaisedAt: null,
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

  it("segundo socket do host substitui o primeiro, que é avisado", async () => {
    const first = await connectHost();
    const { guest } = await joinAndAdmit(first);
    const firstId = first.id;
    const replaced = waitFor(first, "session-replaced");
    const left = waitFor<{ peerId: string }>(guest, "user-left");

    const second = makeClient({ role: "host", jwtCookie: hostJwt() });
    await tryConnect(second);
    const roomPeers = waitFor<{ peers: PeerInfo[] }>(second, "room-peers");
    second.emit("join-room");

    expect(await replaced).not.toBeNull();
    expect(await left).toEqual({ peerId: firstId });
    expect((await roomPeers)?.peers).toEqual([
      { peerId: guest.id, role: "guest", name: "Maria", micMuted: false, handRaisedAt: null },
    ]);
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

describe("signaling — microfone dos participantes", () => {
  it("avisa os demais quando alguém muta ou desmuta o próprio microfone", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");

    const atHost = waitFor(host, "peer-mic-state");
    const atJoao = waitFor(joao.guest, "peer-mic-state");
    const atSelf = waitFor(maria.guest, "peer-mic-state");
    maria.guest.emit("mic-state", { muted: true });

    expect(await atHost).toEqual({ peerId: maria.guest.id, muted: true });
    expect(await atJoao).toEqual({ peerId: maria.guest.id, muted: true });
    expect(await atSelf).toBeNull();

    const unmuted = waitFor(host, "peer-mic-state");
    maria.guest.emit("mic-state", { muted: false });
    expect(await unmuted).toEqual({ peerId: maria.guest.id, muted: false });
  });

  it("quem entra recebe o estado do microfone de quem já está", async () => {
    const host = await connectHost();
    const stateChanged = waitFor(host, "peer-mic-state");
    const maria = await joinAndAdmit(host, "Maria");
    maria.guest.emit("mic-state", { muted: true });
    await stateChanged;

    const joined = waitFor<PeerInfo>(host, "user-joined", 1000);
    const joao = await joinAndAdmit(host, "João");
    expect(joao.peers).toEqual(
      expect.arrayContaining([
        { peerId: maria.guest.id, role: "guest", name: "Maria", micMuted: true, handRaisedAt: null },
      ]),
    );
    expect(await joined).toMatchObject({ name: "João", micMuted: false });
  });

  it("join-room informa se quem entra já está mutado", async () => {
    const host = makeClient({ role: "host", jwtCookie: hostJwt() });
    await tryConnect(host);
    const peers = waitFor(host, "room-peers");
    host.emit("join-room", { micMuted: true });
    await peers;

    const { peers: guestPeers } = await joinAndAdmit(host);
    expect(guestPeers).toEqual([
      { peerId: host.id, role: "host", name: "Psicólogo", micMuted: true, handRaisedAt: null },
    ]);
  });

  it("host muta um paciente: o paciente é avisado e todos veem o mudo", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");

    const forced = waitFor(maria.guest, "force-muted");
    const atHost = waitFor(host, "peer-mic-state");
    const atJoao = waitFor(joao.guest, "peer-mic-state");
    host.emit("mute-participant", { peerId: maria.guest.id });

    expect(await forced).not.toBeNull();
    expect(await atHost).toEqual({ peerId: maria.guest.id, muted: true });
    expect(await atJoao).toEqual({ peerId: maria.guest.id, muted: true });

    // Só o próprio paciente desmuta
    const unmuted = waitFor(joao.guest, "peer-mic-state");
    maria.guest.emit("mic-state", { muted: false });
    expect(await unmuted).toEqual({ peerId: maria.guest.id, muted: false });
  });

  it("paciente não consegue mutar outro participante", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");

    const forced = waitFor(joao.guest, "force-muted");
    const forcedHost = waitFor(host, "force-muted");
    maria.guest.emit("mute-participant", { peerId: joao.guest.id });
    maria.guest.emit("mute-participant", { peerId: host.id });

    expect(await forced).toBeNull();
    expect(await forcedHost).toBeNull();
  });

  it("ignora mute de quem não está na chamada e mic-state inválido", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const request = waitFor<{ guestId: string }>(host, "guest-waiting");
    const waiting = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN, name: "Ana" });
    await request;

    const forced = waitFor(waiting, "force-muted");
    host.emit("mute-participant", { peerId: waiting.id });
    expect(await forced).toBeNull();

    const atHost = waitFor(host, "peer-mic-state");
    guest.emit("mic-state", { muted: "sim" });
    waiting.emit("mic-state", { muted: true });
    expect(await atHost).toBeNull();
  });
});

describe("signaling — levantar a mão", () => {
  it("paciente levanta a mão: todos (inclusive ele) recebem o carimbo", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");

    const atHost = waitFor<{ peerId: string; raisedAt: number | null }>(host, "hand-state");
    const atJoao = waitFor<{ peerId: string; raisedAt: number | null }>(joao.guest, "hand-state");
    const atSelf = waitFor<{ peerId: string; raisedAt: number | null }>(maria.guest, "hand-state");
    maria.guest.emit("raise-hand", { raised: true });

    const state = (await atHost)!;
    expect(state.peerId).toBe(maria.guest.id);
    expect(typeof state.raisedAt).toBe("number");
    expect(await atJoao).toEqual(state);
    expect(await atSelf).toEqual(state);

    const lowered = waitFor(host, "hand-state");
    maria.guest.emit("raise-hand", { raised: false });
    expect(await lowered).toEqual({ peerId: maria.guest.id, raisedAt: null });
  });

  it("a ordem das mãos segue quem levantou primeiro", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");

    const first = waitFor<{ raisedAt: number }>(host, "hand-state");
    joao.guest.emit("raise-hand", { raised: true });
    const joaoAt = (await first)!.raisedAt;
    const second = waitFor<{ raisedAt: number }>(host, "hand-state");
    maria.guest.emit("raise-hand", { raised: true });
    const mariaAt = (await second)!.raisedAt;

    expect(joaoAt).toBeLessThan(mariaAt);
  });

  it("quem entra recebe as mãos já levantadas", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const raised = waitFor<{ raisedAt: number }>(host, "hand-state");
    maria.guest.emit("raise-hand", { raised: true });
    const { raisedAt } = (await raised)!;

    const joao = await joinAndAdmit(host, "João");
    expect(joao.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: maria.guest.id, handRaisedAt: raisedAt }),
      ]),
    );
  });

  it("host abaixa a mão de um paciente", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const raised = waitFor(maria.guest, "hand-state");
    maria.guest.emit("raise-hand", { raised: true });
    await raised;

    const atSelf = waitFor(maria.guest, "hand-state");
    host.emit("lower-hand", { peerId: maria.guest.id });
    expect(await atSelf).toEqual({ peerId: maria.guest.id, raisedAt: null });
  });

  it("host não levanta a mão e paciente não abaixa a de outro", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const joao = await joinAndAdmit(host, "João");
    const raised = waitFor(joao.guest, "hand-state");
    joao.guest.emit("raise-hand", { raised: true });
    await raised;

    const atJoao = waitFor(joao.guest, "hand-state");
    host.emit("raise-hand", { raised: true });
    maria.guest.emit("lower-hand", { peerId: joao.guest.id });
    maria.guest.emit("raise-hand", { raised: "sim" });
    expect(await atJoao).toBeNull();
  });

  it("paciente que volta com a chave mantém a mão e o lugar na fila", async () => {
    const host = await connectHost();
    const maria = await joinAndAdmit(host, "Maria");
    const raised = waitFor<{ raisedAt: number }>(host, "hand-state");
    maria.guest.emit("raise-hand", { raised: true });
    const { raisedAt } = (await raised)!;

    const rejoined = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      name: "Maria",
      admissionKey: maria.admissionKey,
    });
    await tryConnect(rejoined);
    const own = waitFor(rejoined, "hand-state");
    const joined = waitFor(host, "user-joined");
    rejoined.emit("join-room", { handRaised: true });

    expect(await joined).toMatchObject({ name: "Maria", handRaisedAt: raisedAt });
    expect(await own).toEqual({ peerId: rejoined.id, raisedAt });
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

// Simula o celular indo para segundo plano: o transporte cai sem o cliente
// pedir para sair (o servidor vê "transport close", não um disconnect)
function dropTransport(client: ClientSocket): Promise<void> {
  return new Promise((resolve) => {
    client.once("disconnect", () => resolve());
    client.io.engine.close();
  });
}

describe("signaling — quedas involuntárias (app em segundo plano)", () => {
  it("mantém o participante durante a tolerância e só depois emite user-left", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const guestId = guest.id;

    const earlyLeft = waitFor(host, "user-left", 200);
    await dropTransport(guest);
    expect(await earlyLeft).toBeNull();

    expect(await waitFor(host, "user-left", 1000)).toEqual({ peerId: guestId });
  });

  it("socket recuperado volta à chamada com o mesmo id, sem renegociar", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const guestId = guest.id;

    await dropTransport(guest);
    const reconnected = tryConnect(guest);
    guest.connect();
    await reconnected;
    expect(guest.recovered).toBe(true);
    expect(guest.id).toBe(guestId);

    const roomPeers = waitFor(guest, "room-peers", 200);
    const joined = waitFor(host, "user-joined", 200);
    guest.emit("join-room");
    expect(await roomPeers).toBeNull();
    expect(await joined).toBeNull();

    // A remoção agendada foi cancelada
    expect(await waitFor(host, "user-left", 700)).toBeNull();

    // A sinalização segue funcionando entre os dois
    const offer = waitFor(guest, "offer");
    host.emit("offer", { to: guestId, offer: { type: "offer", sdp: "sdp" } });
    expect(await offer).toEqual(expect.objectContaining({ from: host.id }));
  });

  it("paciente que volta com outro socket substitui a vaga antiga", async () => {
    const host = await connectHost();
    const { guest, admissionKey } = await joinAndAdmit(host);
    const oldId = guest.id;
    await dropTransport(guest);

    const left = waitFor<{ peerId: string }>(host, "user-left");
    const fresh = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      name: "Maria",
      admissionKey,
    });
    await tryConnect(fresh);
    const roomPeers = waitFor<{ peers: PeerInfo[] }>(fresh, "room-peers");
    fresh.emit("join-room");

    expect(await left).toEqual({ peerId: oldId });
    expect((await roomPeers)?.peers).toEqual([
      { peerId: host.id, role: "host", name: "Psicólogo", micMuted: false, handRaisedAt: null },
    ]);
  });

  it("host que volta com outro socket substitui o host antigo", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const oldHostId = host.id;
    await dropTransport(host);

    const left = waitFor<{ peerId: string }>(guest, "user-left");
    const fresh = makeClient({ role: "host", jwtCookie: hostJwt() });
    await tryConnect(fresh);
    const roomPeers = waitFor<{ peers: PeerInfo[] }>(fresh, "room-peers");
    fresh.emit("join-room");

    expect(await left).toEqual({ peerId: oldHostId });
    expect((await roomPeers)?.peers).toEqual([
      { peerId: guest.id, role: "guest", name: "Maria", micMuted: false, handRaisedAt: null },
    ]);
  });

  it("sair de propósito continua removendo na hora", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const guestId = guest.id;

    const left = waitFor<{ peerId: string }>(host, "user-left", 200);
    guest.disconnect();
    expect(await left).toEqual({ peerId: guestId });
  });

  it("encaminha restart-ice ao destinatário", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const restart = waitFor(host, "restart-ice");
    guest.emit("restart-ice", { to: host.id });
    expect(await restart).toEqual({ from: guest.id });
  });
});

describe("signaling — mesma pessoa com dois sockets", () => {
  it("paciente que volta antes de o servidor notar a queda não aparece duas vezes", async () => {
    const host = await connectHost();
    const { guest, admissionKey } = await joinAndAdmit(host);
    const oldId = guest.id;
    // O socket antigo ainda parece vivo (celular congelado, sem ping timeout)
    const replaced = waitFor(guest, "session-replaced");
    const left = waitFor<{ peerId: string }>(host, "user-left");
    const joinedIds: string[] = [];
    host.on("user-joined", ({ peerId }: PeerInfo) => joinedIds.push(peerId));

    const fresh = makeClient({
      role: "guest",
      accessToken: ACCESS_TOKEN,
      name: "Maria",
      admissionKey,
    });
    await tryConnect(fresh);
    fresh.emit("join-room");

    expect(await left).toEqual({ peerId: oldId });
    expect(await replaced).not.toBeNull();
    await vi.waitFor(() => expect(joinedIds).toContain(fresh.id));
  });
});

describe("signaling — chat da chamada", () => {
  interface ChatAck {
    ok: boolean;
    id?: string;
    error?: string;
  }

  function sendChat(client: ClientSocket, payload: unknown): Promise<ChatAck> {
    return client.timeout(1000).emitWithAck("chat-message", payload);
  }

  it("repassa texto aos outros participantes, não ao remetente", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);
    const { guest: guest2 } = await joinAndAdmit(host, "João");

    const atHost = waitFor<Record<string, unknown>>(host, "chat-message");
    const atGuest2 = waitFor<Record<string, unknown>>(guest2, "chat-message");
    const echo = waitFor(guest, "chat-message");
    const ack = await sendChat(guest, { text: "  bom dia  " });

    expect(ack.ok).toBe(true);
    const received = await atHost;
    expect(received).toMatchObject({
      id: ack.id,
      from: guest.id,
      senderName: "Maria",
      senderRole: "guest",
      text: "bom dia",
    });
    expect(await atGuest2).toMatchObject({ id: ack.id });
    expect(await echo).toBeNull();
  });

  it("repassa arquivos como binário com o tipo definido pelo servidor", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const atGuest = waitFor<{ file: { name: string; type: string; size: number; data: Buffer } }>(
      guest,
      "chat-message",
    );
    const ack = await sendChat(host, { file: { name: "desenho.png", data: png } });

    expect(ack.ok).toBe(true);
    const { file } = (await atGuest)!;
    expect(file).toMatchObject({ name: "desenho.png", type: "image/png", size: png.length });
    expect(Buffer.from(file.data).equals(png)).toBe(true);
  });

  it("aceita arquivo perto do limite de 10 MB", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const big = Buffer.alloc(10 * 1024 * 1024);
    Buffer.from("%PDF").copy(big);
    const atGuest = waitFor<{ file: { size: number } }>(guest, "chat-message", 3000);
    const ack = await sendChat(host, { file: { name: "a.pdf", data: big } });

    expect(ack.ok).toBe(true);
    expect((await atGuest)?.file.size).toBe(big.length);
  });

  it("recusa tipo de arquivo não permitido sem repassar", async () => {
    const host = await connectHost();
    const { guest } = await joinAndAdmit(host);

    const atGuest = waitFor(guest, "chat-message");
    const ack = await sendChat(host, {
      file: { name: "pagina.html", data: Buffer.from("<script></script>") },
    });

    expect(ack).toEqual({ ok: false, error: "unsupported-type" });
    expect(await atGuest).toBeNull();
  });

  it("paciente na sala de espera não envia nem recebe mensagens", async () => {
    const host = await connectHost();
    const request = waitFor(host, "guest-waiting");
    const waiting = await connectAndJoin({ role: "guest", accessToken: ACCESS_TOKEN });
    await request;

    const ack = await sendChat(waiting, { text: "oi" });
    expect(ack).toEqual({ ok: false, error: "not-in-call" });

    const atWaiting = waitFor(waiting, "chat-message");
    await sendChat(host, { text: "mensagem da chamada" });
    expect(await atWaiting).toBeNull();
  });

  it("limita mensagens em sequência", async () => {
    const host = await connectHost();
    await joinAndAdmit(host);

    const acks: ChatAck[] = [];
    for (let i = 0; i < 11; i++) acks.push(await sendChat(host, { text: `m${i}` }));

    expect(acks.slice(0, 10).every((a) => a.ok)).toBe(true);
    expect(acks[10]).toEqual({ ok: false, error: "rate-limited" });
  });
});
