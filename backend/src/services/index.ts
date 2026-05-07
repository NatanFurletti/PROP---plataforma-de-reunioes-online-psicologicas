import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../utils/AppError";
import { prisma } from "../prismaClient";
import { env } from "../config/env";

const JWT_SECRET = env.JWT_SECRET;
const JWT_EXPIRES_IN = env.JWT_EXPIRES_IN;

// Validation schemas
export const registerPsychologistSchema = z.object({
  name: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(8),
  crp: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const createSessionSchema = z.object({
  scheduledAt: z.string().datetime(),
  durationMinutes: z.number().int().min(15).max(480),
});

export const updateSessionStatusSchema = z.object({
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
});

export class AuthService {
  static async registerPsychologist(
    data: z.infer<typeof registerPsychologistSchema>,
  ) {
    const existingPsychologist = await prisma.psychologist.findUnique({
      where: { email: data.email },
    });

    if (existingPsychologist) {
      throw new AppError("Email already in use", 409);
    }

    const passwordHash = await bcryptjs.hash(data.password, 10);

    const psychologist = await prisma.psychologist.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        crp: data.crp,
      },
    });

    return {
      id: psychologist.id,
      email: psychologist.email,
      name: psychologist.name,
    };
  }

  static async loginPsychologist(data: z.infer<typeof loginSchema>) {
    const psychologist = await prisma.psychologist.findUnique({
      where: { email: data.email },
    });

    if (!psychologist) {
      throw new AppError("Invalid credentials", 401);
    }

    const passwordMatch = await bcryptjs.compare(
      data.password,
      psychologist.passwordHash,
    );

    if (!passwordMatch) {
      throw new AppError("Invalid credentials", 401);
    }

    const token = jwt.sign(
      {
        id: psychologist.id,
        email: psychologist.email,
        v: psychologist.tokenVersion,
      },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
      },
    );

    return {
      token,
      psychologist: {
        id: psychologist.id,
        email: psychologist.email,
        name: psychologist.name,
      },
    };
  }

  // Decodifica e verifica assinatura/expiração. Não consulta o DB —
  // a verificação de tokenVersion fica em verifyTokenWithVersion para
  // não obrigar todo handler de socket/route a ir ao DB.
  static verifyToken(token: string): {
    id: string;
    email: string;
    v?: number;
  } {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as {
        id: string;
        email: string;
        v?: number;
      };
      return decoded;
    } catch {
      throw new Error("Invalid token");
    }
  }

  // Verifica assinatura + tokenVersion no DB (uso pelo middleware HTTP autenticado).
  static async verifyTokenWithVersion(
    token: string,
  ): Promise<{ id: string; email: string }> {
    const decoded = AuthService.verifyToken(token);
    const psychologist = await prisma.psychologist.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, tokenVersion: true },
    });
    if (!psychologist) {
      throw new Error("Invalid token");
    }
    if (decoded.v !== psychologist.tokenVersion) {
      throw new Error("Token revoked");
    }
    return { id: psychologist.id, email: psychologist.email };
  }

  static async invalidateTokens(psychologistId: string): Promise<void> {
    await prisma.psychologist.update({
      where: { id: psychologistId },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  static async getById(id: string) {
    const psychologist = await prisma.psychologist.findUnique({
      where: { id },
      select: { id: true, email: true, name: true },
    });
    if (!psychologist) {
      throw new AppError("Not found", 404);
    }
    return psychologist;
  }
}

export class SessionService {
  static async createSession(
    data: z.infer<typeof createSessionSchema>,
    psychologistId: string,
  ) {
    if (new Date(data.scheduledAt) < new Date()) {
      throw new AppError("scheduledAt must be in the future", 400);
    }

    const accessToken = randomUUID();

    const session = await prisma.session.create({
      data: {
        psychologistId,
        scheduledAt: new Date(data.scheduledAt),
        durationMinutes: data.durationMinutes,
        accessToken,
      },
    });

    return session;
  }

  static async getSessionById(sessionId: string) {
    return prisma.session.findUnique({
      where: { id: sessionId },
      include: { psychologist: true },
    });
  }

  static async getPsychologistSessions(psychologistId: string) {
    return prisma.session.findMany({
      where: { psychologistId },
      orderBy: { scheduledAt: "desc" },
    });
  }

  static async updateSessionStatus(
    sessionId: string,
    psychologistId: string,
    status: z.infer<typeof updateSessionStatusSchema>["status"],
  ) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, psychologistId: true },
    });
    if (!session) {
      throw new AppError("Session not found", 404);
    }
    if (session.psychologistId !== psychologistId) {
      throw new AppError("Forbidden", 403);
    }

    const updateData: {
      status: typeof status;
      startedAt?: Date;
      endedAt?: Date;
    } = { status };
    if (status === "IN_PROGRESS") {
      updateData.startedAt = new Date();
    } else if (status === "COMPLETED" || status === "CANCELLED") {
      updateData.endedAt = new Date();
    }

    return prisma.session.update({
      where: { id: sessionId },
      data: updateData,
    });
  }

  static async validateAccessToken(token: string) {
    const session = await prisma.session.findUnique({
      where: { accessToken: token },
      include: { psychologist: true },
    });

    if (!session) {
      throw new AppError("Invalid access token", 404);
    }

    if (session.status === "CANCELLED" || session.status === "COMPLETED") {
      throw new AppError("Session no longer available", 410);
    }

    // Verificar expiração: scheduledAt + durationMinutes + 30min
    const expiresAt = new Date(session.scheduledAt);
    expiresAt.setMinutes(expiresAt.getMinutes() + session.durationMinutes + 30);
    if (new Date() > expiresAt) {
      throw new AppError("Session no longer available", 410);
    }

    return session;
  }
}
