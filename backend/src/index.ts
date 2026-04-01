import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import router from "./routes/index";
import { registerSignalingHandlers } from "./socket/signalingHandler";

dotenv.config();

const app = express();
const httpServer = createServer(app);

export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  },
});

export const prisma = new PrismaClient();

// Registrar handlers de sinalização WebRTC
registerSignalingHandlers(io, prisma);

// Middlewares — ordem importa: cookie-parser antes das rotas
app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  }),
);
app.use(cookieParser());

// Health check (antes das rotas da API)
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Rotas da API montadas em /api
app.use("/api", router);

// Handler 404 — após todas as rotas
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found" });
});

// Middleware global de erros — deve ser o último middleware registrado
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Erros de validação Zod retornam 400 com detalhes dos campos inválidos
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation error",
      issues: err.issues,
    });
  }

  const status = (err as any)?.status ?? 500;
  const message = (err as any)?.message ?? "Internal Server Error";

  // Não logar dados sensíveis em produção (conformidade LGPD)
  if (process.env.NODE_ENV !== "production") {
    console.error(err);
  }

  res.status(status).json({
    error: message,
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3333;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
});
