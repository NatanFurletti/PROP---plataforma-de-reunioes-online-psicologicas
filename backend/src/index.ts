import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  },
});

const prisma = new PrismaClient();

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  }),
);

// Health check
app.get("/api/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Global error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    timestamp: new Date().toISOString(),
  });
});

// 404 handling
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found" });
});

// WebSocket connection
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on(
    "join-room",
    ({ sessionId, role }: { sessionId: string; role: "host" | "guest" }) => {
      socket.join(sessionId);
      socket.to(sessionId).emit("user-joined", { role });
    },
  );

  socket.on(
    "offer",
    ({ sessionId, offer }: { sessionId: string; offer: any }) => {
      socket.to(sessionId).emit("offer", offer);
    },
  );

  socket.on(
    "answer",
    ({ sessionId, answer }: { sessionId: string; answer: any }) => {
      socket.to(sessionId).emit("answer", answer);
    },
  );

  socket.on(
    "ice-candidate",
    ({ sessionId, candidate }: { sessionId: string; candidate: any }) => {
      socket.to(sessionId).emit("ice-candidate", candidate);
    },
  );

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3333;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  await prisma.$disconnect();
  httpServer.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
