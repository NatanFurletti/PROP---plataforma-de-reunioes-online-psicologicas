import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { ZodError } from "zod";
import router from "./routes/index";
import { registerSignalingHandlers } from "./socket/signalingHandler";
import { prisma } from "./prismaClient";
import { env } from "./config/env";
import { logger } from "./config/logger";

const app = express();
const httpServer = createServer(app);

export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.CLIENT_URL,
    credentials: true,
  },
});

export { prisma };

// Registrar handlers de sinalização WebRTC
registerSignalingHandlers(io, prisma);

// Middlewares — ordem importa: helmet → cors → parsers → cookie → logger → rotas
app.use(helmet());
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(
  pinoHttp({
    logger,
    // Reduzir verbosidade — não logamos health checks
    autoLogging: {
      ignore: (req) => req.url === "/api/health",
    },
  }),
);

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
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  // Erros de validação Zod retornam 400 com detalhes dos campos inválidos
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation error",
      issues: err.issues,
    });
  }

  const status =
    (err as { status?: number })?.status ??
    (err as { statusCode?: number })?.statusCode ??
    500;
  const message =
    (err as { message?: string })?.message ?? "Internal Server Error";

  // Logar erro estruturado — req.log inclui requestId/método/url quando pino-http está ativo
  (req.log ?? logger).error(
    { err, status },
    "Request failed",
  );

  res.status(status).json({
    error: message,
    timestamp: new Date().toISOString(),
  });
});

httpServer.listen(env.PORT, () => {
  logger.info(`Server running on http://localhost:${env.PORT}`);
  logger.info(`WebSocket ready on ws://localhost:${env.PORT}`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down gracefully");
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
