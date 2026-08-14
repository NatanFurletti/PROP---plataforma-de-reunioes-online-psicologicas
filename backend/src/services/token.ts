import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../prismaClient";
import { AppError } from "../utils/AppError";

export type TokenType = "EMAIL_VERIFICATION" | "PASSWORD_RESET";

// Validade por tipo: reset de senha é mais sensível, expira antes.
const TTL_MS: Record<TokenType, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, // 24h
  PASSWORD_RESET: 60 * 60 * 1000, // 1h
};

// SHA-256 basta aqui: o token tem 256 bits de entropia, então não há
// espaço de busca para força bruta como haveria numa senha escolhida.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class TokenService {
  // Gera um token de uso único e persiste apenas o hash.
  // Devolve o valor em claro, que só existe no link enviado por e-mail.
  static async issue(
    psychologistId: string,
    type: TokenType,
  ): Promise<string> {
    const token = randomBytes(32).toString("hex");

    await prisma.verificationToken.create({
      data: {
        psychologistId,
        tokenHash: hashToken(token),
        type,
        expiresAt: new Date(Date.now() + TTL_MS[type]),
      },
    });

    return token;
  }

  // Valida e consome o token. Uso único: marca usedAt na mesma operação.
  static async consume(
    token: string,
    type: TokenType,
  ): Promise<{ psychologistId: string }> {
    const record = await prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    if (!record || record.type !== type) {
      throw new AppError("Invalid or expired token", 400);
    }
    if (record.usedAt) {
      throw new AppError("Invalid or expired token", 400);
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new AppError("Invalid or expired token", 400);
    }

    // updateMany com usedAt: null garante que dois pedidos simultâneos
    // não consumam o mesmo token — só um dos dois altera uma linha.
    const claimed = await prisma.verificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new AppError("Invalid or expired token", 400);
    }

    return { psychologistId: record.psychologistId };
  }

  // Invalida tokens pendentes do mesmo tipo — usado ao emitir um novo,
  // para que apenas o link mais recente funcione.
  static async invalidatePending(
    psychologistId: string,
    type: TokenType,
  ): Promise<void> {
    await prisma.verificationToken.updateMany({
      where: { psychologistId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
