import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1h";

const prismaMock = {
  psychologist: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  session: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock("../prismaClient", () => ({ prisma: prismaMock }));

const { SessionService } = await import("./index");

describe("SessionService.createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita scheduledAt no passado", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(
      SessionService.createSession(
        { scheduledAt: past, durationMinutes: 50 },
        "user-1",
      ),
    ).rejects.toMatchObject({
      message: "scheduledAt must be in the future",
      status: 400,
    });
  });

  it("cria sessão com accessToken UUID", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    prismaMock.session.create.mockResolvedValue({
      id: "s1",
      psychologistId: "user-1",
    });
    await SessionService.createSession(
      { scheduledAt: future, durationMinutes: 50 },
      "user-1",
    );
    const arg = prismaMock.session.create.mock.calls[0][0];
    expect(arg.data.psychologistId).toBe("user-1");
    expect(arg.data.accessToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("SessionService.updateSessionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita 404 quando sessão não existe", async () => {
    prismaMock.session.findUnique.mockResolvedValue(null);
    await expect(
      SessionService.updateSessionStatus("missing", "user-1", "COMPLETED"),
    ).rejects.toMatchObject({ message: "Session not found", status: 404 });
  });

  it("rejeita 403 quando psicólogo não é dono da sessão", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "OTHER-USER",
    });
    await expect(
      SessionService.updateSessionStatus("s1", "user-1", "COMPLETED"),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });

  it("atualiza com endedAt quando status=COMPLETED", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "user-1",
    });
    prismaMock.session.update.mockResolvedValue({ id: "s1" });
    await SessionService.updateSessionStatus("s1", "user-1", "COMPLETED");
    const arg = prismaMock.session.update.mock.calls[0][0];
    expect(arg.data.status).toBe("COMPLETED");
    expect(arg.data.endedAt).toBeInstanceOf(Date);
  });

  it("atualiza com startedAt quando status=IN_PROGRESS", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "user-1",
    });
    prismaMock.session.update.mockResolvedValue({ id: "s1" });
    await SessionService.updateSessionStatus("s1", "user-1", "IN_PROGRESS");
    const arg = prismaMock.session.update.mock.calls[0][0];
    expect(arg.data.status).toBe("IN_PROGRESS");
    expect(arg.data.startedAt).toBeInstanceOf(Date);
  });
});

describe("SessionService.validateAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita token inexistente com 404", async () => {
    prismaMock.session.findUnique.mockResolvedValue(null);
    await expect(
      SessionService.validateAccessToken("nope"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejeita sessão CANCELLED com 410", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      status: "CANCELLED",
      scheduledAt: new Date(),
      durationMinutes: 50,
      psychologist: { name: "Dr. Foo" },
    });
    await expect(
      SessionService.validateAccessToken("tok"),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("rejeita sessão expirada com 410", async () => {
    const longAgo = new Date(Date.now() - 1000 * 60 * 60 * 24); // 24h atrás
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      status: "SCHEDULED",
      scheduledAt: longAgo,
      durationMinutes: 50,
      psychologist: { name: "Dr. Foo" },
    });
    await expect(
      SessionService.validateAccessToken("tok"),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("aceita sessão SCHEDULED dentro do horário", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      status: "SCHEDULED",
      scheduledAt: new Date(),
      durationMinutes: 50,
      psychologist: { name: "Dr. Foo" },
    });
    const result = await SessionService.validateAccessToken("tok");
    expect(result.id).toBe("s1");
  });
});
