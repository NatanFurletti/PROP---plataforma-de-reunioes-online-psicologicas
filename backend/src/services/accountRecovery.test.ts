import { beforeEach, describe, expect, it, vi } from "vitest";
import bcryptjs from "bcryptjs";

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
    update: vi.fn(),
  },
  verificationToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock("../prismaClient", () => ({ prisma: prismaMock }));

const { AuthService, SessionService } = await import("./index");
const { InMemoryEmailDriver, setEmailDriver } = await import("./email");
const { hashToken } = await import("./token");

let mailbox: InstanceType<typeof InMemoryEmailDriver>;

beforeEach(() => {
  vi.clearAllMocks();
  mailbox = new InMemoryEmailDriver();
  setEmailDriver(mailbox);
  prismaMock.verificationToken.create.mockResolvedValue({ id: "t1" });
  prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.psychologist.update.mockResolvedValue({ id: "p1" });
});

describe("registro → verificação de e-mail", () => {
  it("envia e-mail de verificação ao registrar", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(null);
    prismaMock.psychologist.create.mockResolvedValue({
      id: "p1",
      email: "ana@test.com",
      name: "Ana",
    });

    await AuthService.registerPsychologist({
      name: "Ana Silva",
      email: "ana@test.com",
      password: "senha-forte-123",
    });

    expect(mailbox.sent).toHaveLength(1);
    expect(mailbox.sent[0].to).toBe("ana@test.com");
    expect(mailbox.sent[0].text).toMatch(/verify-email\/[0-9a-f]{64}/);
  });

  it("não derruba o cadastro se o envio de e-mail falhar", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(null);
    prismaMock.psychologist.create.mockResolvedValue({
      id: "p1",
      email: "ana@test.com",
      name: "Ana",
    });
    setEmailDriver({
      send: async () => {
        throw new Error("SMTP down");
      },
    });

    const result = await AuthService.registerPsychologist({
      name: "Ana Silva",
      email: "ana@test.com",
      password: "senha-forte-123",
    });

    expect(result.id).toBe("p1");
  });

  it("verifyEmail marca emailVerifiedAt", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      id: "t1",
      psychologistId: "p1",
      type: "EMAIL_VERIFICATION",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    await AuthService.verifyEmail("tok");

    const call = prismaMock.psychologist.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "p1" });
    expect(call.data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("verifyEmail rejeita token inválido", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(null);
    await expect(AuthService.verifyEmail("nope")).rejects.toMatchObject({
      status: 400,
    });
    expect(prismaMock.psychologist.update).not.toHaveBeenCalled();
  });
});

describe("recuperação de senha", () => {
  const account = {
    id: "p1",
    email: "ana@test.com",
    name: "Ana",
    passwordHash: "hash-antigo",
    tokenVersion: 0,
  };

  it("envia e-mail de reset para conta existente", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(account);
    await AuthService.requestPasswordReset("ana@test.com");

    expect(mailbox.sent).toHaveLength(1);
    expect(mailbox.sent[0].text).toMatch(/reset-password\/[0-9a-f]{64}/);
  });

  it("invalida links anteriores ao emitir um novo", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(account);
    await AuthService.requestPasswordReset("ana@test.com");

    const call = prismaMock.verificationToken.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      psychologistId: "p1",
      type: "PASSWORD_RESET",
      usedAt: null,
    });
  });

  it("não revela se a conta existe", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(account);
    const existing = await AuthService.requestPasswordReset("ana@test.com");

    vi.clearAllMocks();
    mailbox = new InMemoryEmailDriver();
    setEmailDriver(mailbox);
    prismaMock.psychologist.findUnique.mockResolvedValue(null);
    const missing = await AuthService.requestPasswordReset("nao@existe.com");

    // Mesma resposta nos dois casos — o endpoint nao pode ser um oraculo
    expect(missing).toEqual(existing);
    expect(mailbox.sent).toHaveLength(0);
  });

  it("resetPassword troca o hash da senha", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      id: "t1",
      psychologistId: "p1",
      type: "PASSWORD_RESET",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    await AuthService.resetPassword("tok", "nova-senha-123");

    const { data } = prismaMock.psychologist.update.mock.calls[0][0];
    expect(data.passwordHash).not.toBe("hash-antigo");
    expect(await bcryptjs.compare("nova-senha-123", data.passwordHash)).toBe(
      true,
    );
  });

  it("resetPassword revoga as sessões ativas via tokenVersion", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      id: "t1",
      psychologistId: "p1",
      type: "PASSWORD_RESET",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    await AuthService.resetPassword("tok", "nova-senha-123");

    const { data } = prismaMock.psychologist.update.mock.calls[0][0];
    expect(data.tokenVersion).toEqual({ increment: 1 });
  });

  it("resetPassword rejeita token de verificação de e-mail", async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      id: "t1",
      psychologistId: "p1",
      type: "EMAIL_VERIFICATION",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    await expect(
      AuthService.resetPassword("tok", "nova-senha-123"),
    ).rejects.toMatchObject({ status: 400 });
    expect(prismaMock.psychologist.update).not.toHaveBeenCalled();
  });

  it("o token enviado por e-mail casa com o hash persistido", async () => {
    prismaMock.psychologist.findUnique.mockResolvedValue(account);
    await AuthService.requestPasswordReset("ana@test.com");

    const link = mailbox.sent[0].text.match(/reset-password\/([0-9a-f]{64})/);
    const emailedToken = link?.[1];
    const { data } = prismaMock.verificationToken.create.mock.calls[0][0];
    expect(data.tokenHash).toBe(hashToken(emailedToken!));
  });
});

describe("SessionService.rescheduleSession", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();

  it("atualiza a data da sessão agendada", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "p1",
      status: "SCHEDULED",
    });
    prismaMock.session.update.mockResolvedValue({ id: "s1" });

    await SessionService.rescheduleSession("s1", "p1", { scheduledAt: future });

    const { data } = prismaMock.session.update.mock.calls[0][0];
    expect(data.scheduledAt).toEqual(new Date(future));
  });

  it("rejeita data no passado", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "p1",
      status: "SCHEDULED",
    });

    await expect(
      SessionService.rescheduleSession("s1", "p1", {
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejeita 404 para sessão inexistente", async () => {
    prismaMock.session.findUnique.mockResolvedValue(null);
    await expect(
      SessionService.rescheduleSession("nope", "p1", { scheduledAt: future }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejeita 403 quando não é o dono", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "OUTRO",
      status: "SCHEDULED",
    });

    await expect(
      SessionService.rescheduleSession("s1", "p1", { scheduledAt: future }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });

  it("rejeita 409 para sessão já concluída", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "p1",
      status: "COMPLETED",
    });

    await expect(
      SessionService.rescheduleSession("s1", "p1", { scheduledAt: future }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("mantém a duração quando não informada", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      psychologistId: "p1",
      status: "SCHEDULED",
    });
    prismaMock.session.update.mockResolvedValue({ id: "s1" });

    await SessionService.rescheduleSession("s1", "p1", { scheduledAt: future });

    const { data } = prismaMock.session.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("durationMinutes");
  });
});
