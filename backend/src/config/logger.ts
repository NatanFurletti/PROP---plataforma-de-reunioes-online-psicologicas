import pino from "pino";
import { env } from "./env";

// Logger estruturado.
// Em produção: JSON sem colorização, ideal para coletores (ELK, Loki, etc.).
// Em dev: pino-pretty para legibilidade humana.
// IMPORTANTE: nunca logar conteúdo sensível (senhas, tokens, dados de paciente).
// O `redact` abaixo remove campos comuns que possam vazar acidentalmente.
export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "password",
      "passwordHash",
      "token",
      "jwt",
      "accessToken",
      "authorization",
      "cookie",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.jwt",
      "*.accessToken",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  transport:
    env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
});
