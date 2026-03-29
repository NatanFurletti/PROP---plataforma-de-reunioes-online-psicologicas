import { Router, Request, Response, NextFunction } from "express";
import * as controllers from "../controllers/index";
import { AuthService } from "../services/index";

const router = Router();

// Auth middleware
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies.jwt || req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = AuthService.verifyToken(token);
    (req as any).user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// Public routes
router.post("/auth/register", controllers.registerPsychologist);
router.post("/auth/login", controllers.loginPsychologist);
router.get("/sessions/join/:token", controllers.validateSessionToken);

// Protected routes
router.post("/auth/logout", authMiddleware, controllers.logoutPsychologist);
router.post("/sessions", authMiddleware, controllers.createSession);
router.get("/sessions", authMiddleware, controllers.listSessions);
router.get("/sessions/:id", authMiddleware, controllers.getSession);
router.patch(
  "/sessions/:id/status",
  authMiddleware,
  controllers.updateSessionStatus,
);

export default router;
