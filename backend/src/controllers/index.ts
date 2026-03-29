import { Request, Response, NextFunction } from "express";
import {
  AuthService,
  SessionService,
  registerPsychologistSchema,
  loginSchema,
  createSessionSchema,
} from "../services/index";

export const registerPsychologist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const validatedData = registerPsychologistSchema.parse(req.body);
    const psychologist = await AuthService.registerPsychologist(validatedData);

    res.status(201).json(psychologist);
  } catch (error) {
    next(error);
  }
};

export const loginPsychologist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const { token, psychologist } =
      await AuthService.loginPsychologist(validatedData);

    // Set HTTP-only cookie
    res.cookie("jwt", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    });

    res.json({ psychologist });
  } catch (error) {
    next(error);
  }
};

export const logoutPsychologist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    res.cookie("jwt", "", { maxAge: 0 });
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
};

export const createSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const psychologistId = (req as any).user?.id;
    if (!psychologistId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const validatedData = createSessionSchema.parse(req.body);
    const session = await SessionService.createSession(
      validatedData,
      psychologistId,
    );

    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
};

export const listSessions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const psychologistId = (req as any).user?.id;
    if (!psychologistId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sessions =
      await SessionService.getPsychologistSessions(psychologistId);
    res.json(sessions);
  } catch (error) {
    next(error);
  }
};

export const getSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const session = await SessionService.getSessionById(id);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json(session);
  } catch (error) {
    next(error);
  }
};

export const updateSessionStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const updatedSession = await SessionService.updateSessionStatus(id, status);
    res.json(updatedSession);
  } catch (error) {
    next(error);
  }
};

export const validateSessionToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token } = req.params;
    const session = await SessionService.validateAccessToken(token);

    res.json({ valid: true, sessionId: session.id });
  } catch (error) {
    res.status(401).json({ valid: false, error: "Invalid token" });
  }
};
