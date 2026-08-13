import { Request, Response, NextFunction } from "express";
import {
  AuthService,
  SessionService,
  registerPsychologistSchema,
  loginSchema,
  createSessionSchema,
  updateSessionStatusSchema,
} from "../services/index";
import { AppError } from "../utils/AppError";

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
      sameSite: "strict",
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
    const userId = req.user?.id;
    if (userId) {
      // Incrementa tokenVersion no DB → invalida o JWT atual e quaisquer
      // outras sessões abertas em outros dispositivos do mesmo usuário.
      await AuthService.invalidateTokens(userId);
    }

    res.clearCookie("jwt", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
};

export const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const psychologist = await AuthService.getById(userId);
    res.json({ psychologist });
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
    const psychologistId = req.user?.id;
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
    const psychologistId = req.user?.id;
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
    const psychologistId = req.user?.id;
    const session = await SessionService.getSessionById(id);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.psychologistId !== psychologistId) {
      return next(new AppError("Forbidden", 403));
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
    const psychologistId = req.user?.id;
    if (!psychologistId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const { status } = updateSessionStatusSchema.parse(req.body);

    const updatedSession = await SessionService.updateSessionStatus(
      id,
      psychologistId,
      status,
    );
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

    res.json({
      sessionId: session.id,
      scheduledAt: session.scheduledAt,
      durationMinutes: session.durationMinutes,
      psychologistName: session.psychologist?.name ?? "",
    });
  } catch (error) {
    next(error);
  }
};
