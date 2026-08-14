import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";

const prismaMock = {
  verificationToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock("../prismaClient", () => ({ prisma: prismaMock }));

const { TokenService, hashToken } = await import("./token");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.verificationToken.create.mockResolvedValue({ id: "t1" });
  prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 1 });
});

describe("TokenService.issue", () => {
  it("persiste apenas o hash, nunca o token em claro", async () => {
    const token = await TokenService.issue("p1", "EMAIL_VERIFICATION");

    const data = prismaMock.verificationToken.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashToken(token));
    // O valor em claro nao pode aparecer em nenhum campo persistido
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it("gera tokens distintos a cada emissão", async () => {
    const a = await TokenService.issue("p1", "EMAIL_VERIFICATION");
    const b = await TokenService.issue("p1", "EMAIL_VERIFICATION");
    expect(a).not.toBe(b);
  });

  it("gera token com entropia suficiente (32 bytes em hex)", async () => {
    const token = await TokenService.issue("p1", "PASSWORD_RESET");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expira verificação de e-mail em 24h", async () => {
    await TokenService.issue("p1", "EMAIL_VERIFICATION");
    const { expiresAt } = prismaMock.verificationToken.create.mock.calls[0][0].data;
    const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("expira reset de senha em 1h — janela menor que a verificação", async () => {
    await TokenService.issue("p1", "PASSWORD_RESET");
    const { expiresAt } = prismaMock.verificationToken.create.mock.calls[0][0].data;
    const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThanOrEqual(1);
  });
});

describe("TokenService.consume", () => {
  const validRecord = {
    id: "t1",
    psychologistId: "p1",
    type: "PASSWORD_RESET" as const,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  };

  it("aceita token válido e devolve o psicólogo", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(validRecord);
    const result = await TokenService.consume("tok", "PASSWORD_RESET");
    expect(result.psychologistId).toBe("p1");
  });

  it("busca pelo hash, não pelo token em claro", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(validRecord);
    await TokenService.consume("tok", "PASSWORD_RESET");
    expect(prismaMock.verificationToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken("tok") },
    });
  });

  it("marca o token como usado", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(validRecord);
    await TokenService.consume("tok", "PASSWORD_RESET");
    const call = prismaMock.verificationToken.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: "t1", usedAt: null });
    expect(call.data.usedAt).toBeInstanceOf(Date);
  });

  it("rejeita token inexistente", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(null);
    await expect(
      TokenService.consume("nope", "PASSWORD_RESET"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejeita token já usado", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      ...validRecord,
      usedAt: new Date(),
    });
    await expect(
      TokenService.consume("tok", "PASSWORD_RESET"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejeita token expirado", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      ...validRecord,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      TokenService.consume("tok", "PASSWORD_RESET"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejeita token de outro tipo (verificação usada como reset)", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      ...validRecord,
      type: "EMAIL_VERIFICATION",
    });
    await expect(
      TokenService.consume("tok", "PASSWORD_RESET"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejeita quando outra requisição consumiu o token primeiro", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(validRecord);
    // updateMany nao alterou nenhuma linha: perdemos a corrida
    prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      TokenService.consume("tok", "PASSWORD_RESET"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("não revela o motivo da falha na mensagem", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      ...validRecord,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      TokenService.consume("tok", "PASSWORD_RESET"),
    ).rejects.toMatchObject({ message: "Invalid or expired token" });
  });
});

describe("TokenService.invalidatePending", () => {
  it("invalida apenas tokens não usados do tipo indicado", async () => {
    await TokenService.invalidatePending("p1", "PASSWORD_RESET");
    const call = prismaMock.verificationToken.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      psychologistId: "p1",
      type: "PASSWORD_RESET",
      usedAt: null,
    });
  });
});
