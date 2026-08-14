import { logger } from "../config/logger";
import { env } from "../config/env";

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

let driver: EmailDriver = new ConsoleEmailDriver();

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
      subject: "Confirme seu e-mail — PsiConnect",
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
      subject: "Redefinição de senha — PsiConnect",
      text: `Para redefinir sua senha, acesse: ${link}\n\nO link expira em 1 hora. Se você não solicitou, ignore esta mensagem.`,
    });
  }
}
