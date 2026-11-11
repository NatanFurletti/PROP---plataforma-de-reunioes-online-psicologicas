import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Envio de e-mail. "console" só registra o link no log (desenvolvimento);
// "resend" envia de verdade pela API do Resend e exige chave e remetente.
const EMAIL_DRIVER = (process.env.EMAIL_DRIVER?.trim() || "console").toLowerCase();
if (EMAIL_DRIVER !== "console" && EMAIL_DRIVER !== "resend") {
  throw new Error(`Invalid EMAIL_DRIVER: ${EMAIL_DRIVER} (use "console" or "resend")`);
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 3333),
  // Vai no header Access-Control-Allow-Origin, que é comparado letra por letra
  // e não aceita quebra de linha: remove espaços/Enter colados no painel e a
  // barra final.
  CLIENT_URL: (process.env.CLIENT_URL?.trim() || "http://localhost:5173").replace(/\/+$/, ""),
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "8h",
  // Quantos proxies confiáveis ficam na frente do app (Express "trust proxy").
  // Define de onde vem o IP real do cliente, usado no rate limit.
  // Vercel (rewrite) → Render → app = 2. Sem proxy (local) = 0.
  TRUST_PROXY: Math.max(0, Number(process.env.TRUST_PROXY ?? 0) || 0),
  // Máximo de pessoas na chamada, psicólogo incluso (malha P2P)
  MAX_ROOM_PARTICIPANTS: Math.max(2, Number(process.env.MAX_ROOM_PARTICIPANTS ?? 6) || 6),
  // Quanto tempo quem caiu sem sair (ex.: celular em segundo plano) mantém
  // a vaga na sala antes de os outros receberem `user-left`
  RECONNECT_GRACE_MS: Math.max(
    100,
    Number(process.env.RECONNECT_GRACE_MS ?? 120_000) || 120_000,
  ),
  EMAIL_DRIVER: EMAIL_DRIVER as "console" | "resend",
  RESEND_API_KEY: EMAIL_DRIVER === "resend" ? required("RESEND_API_KEY") : "",
  // Ex.: "Palas <nao-responda@seudominio.com.br>" — o domínio precisa estar
  // verificado no Resend.
  EMAIL_FROM: EMAIL_DRIVER === "resend" ? required("EMAIL_FROM") : "",
};
