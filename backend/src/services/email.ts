import { logger } from "../config/logger.js";
import { env } from "../config/env.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

// Driver de envio. Trocar a implementação (SMTP, Resend, SES) não deve
// exigir mudança em quem envia e-mail.
export interface EmailDriver {
  send(message: EmailMessage): Promise<void>;
}

// Driver de desenvolvimento: registra o e-mail no log em vez de enviar.
// O link aparece no console para ser usado manualmente.
export class ConsoleEmailDriver implements EmailDriver {
  async send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject },
      `[email] ${message.subject}\n${message.text}`,
    );
  }
}

// Coleta as mensagens em memória — usado nos testes.
export class InMemoryEmailDriver implements EmailDriver {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

// Envia pela API HTTP do Resend (https://resend.com/docs/api-reference/emails/send-email).
// Usa o fetch nativo do Node — sem dependência extra.
export class ResendEmailDriver implements EmailDriver {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      // O corpo traz só o motivo (ex.: domínio não verificado), sem o
      // conteúdo do e-mail. O destinatário não vai para a mensagem de erro.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Resend respondeu ${response.status}: ${detail.slice(0, 300)}`,
      );
    }
  }
}

function createDefaultDriver(): EmailDriver {
  if (env.EMAIL_DRIVER === "resend") {
    return new ResendEmailDriver(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  if (env.NODE_ENV === "production") {
    // Em produção o driver de console deixa o psicólogo sem o link de
    // verificação/redefinição — e escreve tokens válidos no log.
    logger.warn(
      "[email] EMAIL_DRIVER=console em produção: nenhum e-mail será enviado",
    );
  }
  return new ConsoleEmailDriver();
}

let driver: EmailDriver = createDefaultDriver();

export function setEmailDriver(next: EmailDriver): void {
  driver = next;
}

export class EmailService {
  static async sendVerificationEmail(
    to: string,
    token: string,
  ): Promise<void> {
    const link = `${env.CLIENT_URL}/verify-email/${token}`;
    await driver.send({
      to,
      subject: "Confirme seu e-mail — Palas",
      text: `Para confirmar seu e-mail, acesse: ${link}\n\nO link expira em 24 horas.`,
    });
  }

  static async sendPasswordResetEmail(
    to: string,
    token: string,
  ): Promise<void> {
    const link = `${env.CLIENT_URL}/reset-password/${token}`;
    await driver.send({
      to,
      subject: "Redefinição de senha — Palas",
      text: `Para redefinir sua senha, acesse: ${link}\n\nO link expira em 1 hora. Se você não solicitou, ignore esta mensagem.`,
    });
  }
}
