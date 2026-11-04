import nodemailer from 'nodemailer';

/**
 * Email transport behind an interface (D10, Principle IV). A deterministic in-memory transport drives
 * tests/local with no network; the Mailpit adapter (SMTP) is used when MAIL_SMTP_HOST is configured.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  headers?: Record<string, string>;
}
export interface SentInfo {
  messageId: string;
}
export interface EmailTransport {
  send(email: OutboundEmail): Promise<SentInfo>;
}

/** Offline default: records sent mail in memory. Deterministic ids for tests. */
export class InMemoryEmailTransport implements EmailTransport {
  readonly sent: Array<OutboundEmail & { messageId: string }> = [];
  async send(email: OutboundEmail): Promise<SentInfo> {
    const messageId = `<mem-${this.sent.length + 1}@riverbend.local>`;
    this.sent.push({ ...email, messageId });
    return { messageId };
  }
}

/** SMTP adapter to a local Mailpit (or any SMTP sink). Used only when configured. */
export class MailpitTransport implements EmailTransport {
  private readonly transport: nodemailer.Transporter;
  constructor(private readonly cfg: { host: string; port: number; from: string }) {
    this.transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: false, ignoreTLS: true });
  }
  async send(email: OutboundEmail): Promise<SentInfo> {
    const info = await this.transport.sendMail({
      from: this.cfg.from,
      to: email.to,
      subject: email.subject,
      text: email.body,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      ...(email.headers ? { headers: email.headers } : {}),
    });
    return { messageId: info.messageId };
  }
}
