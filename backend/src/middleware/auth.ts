import { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/index";

export const authenticateToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // Try to get token from cookies first (more secure)
    let token = req.cookies?.jwt;

    // Fallback to Authorization header (for API clients)
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(" ");
      if (parts.length === 2 && parts[0] === "Bearer") {
        token = parts[1];
      }
    }

    if (!token) {
      return res
        .status(401)
        .json({ error: "No authentication token provided" });
    }

    const decoded = AuthService.verifyToken(token);
    (req as any).user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
