import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as controllers from "../controllers/index";
import { authenticateToken as authMiddleware } from "../middleware/auth";

const router = Router();

// Rate limit para endpoints de autenticação — protege contra brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Try again later." },
});

// Rate limit para validação de token público — protege contra enumeração
const joinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

// Public routes
router.post("/auth/register", authLimiter, controllers.registerPsychologist);
router.post("/auth/login", authLimiter, controllers.loginPsychologist);
router.get(
  "/sessions/join/:token",
  joinLimiter,
  controllers.validateSessionToken,
);

// Protected routes
router.get("/auth/me", authMiddleware, controllers.getCurrentUser);
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
