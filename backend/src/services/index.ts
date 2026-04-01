import { PrismaClient } from "@prisma/client";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { AppError } from "../utils/AppError";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

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
      { id: psychologist.id, email: psychologist.email },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
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

  static verifyToken(token: string): { id: string; email: string } {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as {
        id: string;
        email: string;
      };
      return decoded;
    } catch {
      throw new Error("Invalid token");
    }
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

    const accessToken = crypto.randomUUID();

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

  static async updateSessionStatus(sessionId: string, status: string) {
    const updateData: any = { status };
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
