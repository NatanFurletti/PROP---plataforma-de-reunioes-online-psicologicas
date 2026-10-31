import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 3333),
  CLIENT_URL: process.env.CLIENT_URL ?? "http://localhost:5173",
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "8h",
  // Quantos proxies confiáveis ficam na frente do app (Express "trust proxy").
  // Define de onde vem o IP real do cliente, usado no rate limit.
  // Vercel (rewrite) → Render → app = 2. Sem proxy (local) = 0.
  TRUST_PROXY: Math.max(0, Number(process.env.TRUST_PROXY ?? 0) || 0),
  // Máximo de pessoas na chamada, psicólogo incluso (malha P2P)
  MAX_ROOM_PARTICIPANTS: Math.max(2, Number(process.env.MAX_ROOM_PARTICIPANTS ?? 6) || 6),
};
