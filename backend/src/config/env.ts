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
// "resend" e "brevo" enviam de verdade pela API HTTP do serviço e exigem
// chave e remetente.
const EMAIL_DRIVERS = ["console", "resend", "brevo"] as const;
type EmailDriverName = (typeof EMAIL_DRIVERS)[number];
const EMAIL_DRIVER = (process.env.EMAIL_DRIVER?.trim() || "console").toLowerCase();
if (!(EMAIL_DRIVERS as readonly string[]).includes(EMAIL_DRIVER)) {
  throw new Error(
    `Invalid EMAIL_DRIVER: ${EMAIL_DRIVER} (use "console", "resend" or "brevo")`,
  );
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
  EMAIL_DRIVER: EMAIL_DRIVER as EmailDriverName,
  RESEND_API_KEY: EMAIL_DRIVER === "resend" ? required("RESEND_API_KEY") : "",
  BREVO_API_KEY: EMAIL_DRIVER === "brevo" ? required("BREVO_API_KEY") : "",
  // Ex.: "Palas <nao-responda@seudominio.com.br>". No Resend o domínio precisa
  // estar verificado; no Brevo basta o endereço estar verificado como remetente.
  EMAIL_FROM: EMAIL_DRIVER !== "console" ? required("EMAIL_FROM") : "",
};
