import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1h";

const prismaMock = {
  psychologist: { findUnique: vi.fn() },
  session: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock("../prismaClient", () => ({ prisma: prismaMock }));

const {
  registerSignalingHandlers,
  sweepIdleRooms,
  __resetRooms,
  IDLE_ROOM_TIMEOUT_MS,
} = await import("./signalingHandler");

const OWNER_ID = "psy-owner";
const SESSION_ID = "session-idle";
const ACCESS_TOKEN = "guest-token";

let httpServer: HttpServer;
let io: Server;
let port: number;
const openClients: ClientSocket[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRooms();

  prismaMock.psychologist.findUnique.mockResolvedValue({
    id: OWNER_ID,
    email: "owner@test.com",
    tokenVersion: 0,
  });
  prismaMock.session.findUnique.mockResolvedValue({
    id: SESSION_ID,
    psychologistId: OWNER_ID,
    accessToken: ACCESS_TOKEN,
    status: "SCHEDULED",
    scheduledAt: new Date(),
    durationMinutes: 50,
  });
  prismaMock.session.updateMany.mockResolvedValue({ count: 1 });

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
  for (const c of openClients) c.disconnect();
  openClients.length = 0;
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function hostJwt(): string {
  return jwt.sign(
    { id: OWNER_ID, email: "owner@test.com", v: 0 },
    "test-secret-do-not-use-in-prod",
  );
}

async function connectHostAndJoin(): Promise<ClientSocket> {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { sessionId: SESSION_ID, role: "host" },
    extraHeaders: { cookie: `jwt=${hostJwt()}` },
    transports: ["websocket"],
    reconnection: false,
  });
  openClients.push(client);

  await new Promise<void>((resolve, reject) => {
    client.on("connect", () => resolve());
    client.on("connect_error", reject);
  });

  client.emit("join-room");
  // Aguarda o servidor processar o join
  await new Promise((r) => setTimeout(r, 80));
  return client;
}

// Espera a sala registrar a saída do participante
async function waitForDisconnectProcessing() {
  await new Promise((r) => setTimeout(r, 120));
}

describe("expiração de salas inativas", () => {
  it("não encerra sala que ainda tem participante", async () => {
    await connectHostAndJoin();

    const swept = await sweepIdleRooms(
      prismaMock as never,
      Date.now() + IDLE_ROOM_TIMEOUT_MS * 10,
    );

    expect(swept).not.toContain(SESSION_ID);
  });

  it("não encerra sala vazia antes do timeout", async () => {
    const host = await connectHostAndJoin();
    host.disconnect();
    await waitForDisconnectProcessing();

    // Logo após a saída — ainda dentro da janela de reconexão
    const swept = await sweepIdleRooms(prismaMock as never, Date.now());
    expect(swept).not.toContain(SESSION_ID);
  });

  it("encerra sala vazia após o timeout", async () => {
    const host = await connectHostAndJoin();
    host.disconnect();
    await waitForDisconnectProcessing();

    const swept = await sweepIdleRooms(
      prismaMock as never,
      Date.now() + IDLE_ROOM_TIMEOUT_MS + 1000,
    );

    expect(swept).toContain(SESSION_ID);
  });

  it("marca a sessão como COMPLETED ao encerrar por inatividade", async () => {
    const host = await connectHostAndJoin();
    host.disconnect();
    await waitForDisconnectProcessing();

    prismaMock.session.updateMany.mockClear();
    await sweepIdleRooms(
      prismaMock as never,
      Date.now() + IDLE_ROOM_TIMEOUT_MS + 1000,
    );

    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: "IN_PROGRESS" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("não encerra a mesma sala duas vezes", async () => {
    const host = await connectHostAndJoin();
    host.disconnect();
    await waitForDisconnectProcessing();

    const future = Date.now() + IDLE_ROOM_TIMEOUT_MS + 1000;
    const first = await sweepIdleRooms(prismaMock as never, future);
    const second = await sweepIdleRooms(prismaMock as never, future);

    expect(first).toContain(SESSION_ID);
    expect(second).not.toContain(SESSION_ID);
  });

  it("reconexão dentro da janela preserva a sala", async () => {
    const host = await connectHostAndJoin();
    host.disconnect();
    await waitForDisconnectProcessing();

    // Participante volta antes do timeout
    await connectHostAndJoin();

    const swept = await sweepIdleRooms(
      prismaMock as never,
      Date.now() + IDLE_ROOM_TIMEOUT_MS + 1000,
    );

    expect(swept).not.toContain(SESSION_ID);
  });
});
