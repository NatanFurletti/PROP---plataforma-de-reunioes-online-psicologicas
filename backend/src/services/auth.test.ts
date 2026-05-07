import { beforeEach, describe, expect, it, vi } from "vitest";

// Definir env vars antes de qualquer import que dependa de env validado
process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1h";

// Mock do prismaClient — substitui o singleton real
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

const { AuthService } = await import("./index");

describe("AuthService.verifyToken / verifyTokenWithVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita token inválido", () => {
    expect(() => AuthService.verifyToken("not-a-jwt")).toThrow("Invalid token");
  });

  it("aceita token assinado pela mesma chave", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue({
      id: "user-1",
      email: "a@b.c",
      passwordHash: "hash",
      tokenVersion: 0,
      name: "x",
    });
    prismaMock.psychologist.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "a@b.c",
      passwordHash: await (await import("bcryptjs")).default.hash("12345678", 4),
      tokenVersion: 0,
      name: "x",
    });

    const { token } = await AuthService.loginPsychologist({
      email: "a@b.c",
      password: "12345678",
    });

    const decoded = AuthService.verifyToken(token);
    expect(decoded.id).toBe("user-1");
    expect(decoded.email).toBe("a@b.c");
    expect(decoded.v).toBe(0);
  });

  it("verifyTokenWithVersion rejeita quando tokenVersion mudou", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const hash = await bcrypt.hash("12345678", 4);

    // Login com tokenVersion=0
    prismaMock.psychologist.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "a@b.c",
      passwordHash: hash,
      tokenVersion: 0,
      name: "x",
    });
    const { token } = await AuthService.loginPsychologist({
      email: "a@b.c",
      password: "12345678",
    });

    // Verify acha o usuário, mas com tokenVersion incrementada (logout aconteceu)
    prismaMock.psychologist.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "a@b.c",
      tokenVersion: 1,
    });

    await expect(
      AuthService.verifyTokenWithVersion(token),
    ).rejects.toThrow("Token revoked");
  });

  it("verifyTokenWithVersion aceita quando versões batem", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const hash = await bcrypt.hash("12345678", 4);

    prismaMock.psychologist.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "a@b.c",
      passwordHash: hash,
      tokenVersion: 7,
      name: "x",
    });
    const { token } = await AuthService.loginPsychologist({
      email: "a@b.c",
      password: "12345678",
    });

    prismaMock.psychologist.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "a@b.c",
      tokenVersion: 7,
    });
    const decoded = await AuthService.verifyTokenWithVersion(token);
    expect(decoded.id).toBe("user-1");
  });
});

describe("AuthService.invalidateTokens", () => {
  it("incrementa tokenVersion no DB", async () => {
    prismaMock.psychologist.update.mockResolvedValue({});
    await AuthService.invalidateTokens("user-1");
    expect(prismaMock.psychologist.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tokenVersion: { increment: 1 } },
    });
  });
});

describe("AuthService.loginPsychologist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita email inexistente com 'Invalid credentials'", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(null);
    await expect(
      AuthService.loginPsychologist({ email: "x@y.z", password: "12345678" }),
    ).rejects.toMatchObject({ message: "Invalid credentials", status: 401 });
  });

  it("rejeita senha incorreta com 'Invalid credentials'", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    prismaMock.psychologist.findUnique.mockResolvedValue({
      id: "u1",
      email: "x@y.z",
      passwordHash: await bcrypt.hash("correct-password", 4),
      tokenVersion: 0,
      name: "x",
    });
    await expect(
      AuthService.loginPsychologist({ email: "x@y.z", password: "wrong" }),
    ).rejects.toMatchObject({ message: "Invalid credentials", status: 401 });
  });
});
