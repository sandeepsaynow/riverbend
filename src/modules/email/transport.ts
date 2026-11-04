import { Resend } from 'resend';

/**
 * Email transport behind an interface (D10/D21, Principle IV). A deterministic in-memory transport
 * drives tests/local with no network; the Resend adapter is used when RESEND_API_KEY is configured.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  body: string; // plain text
  html?: string; // sanitised HTML alternative (optional)
  replyTo?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string; // provider-side dedupe (24h) so job retries never double-send
}
export interface SentInfo {
  messageId: string;
}
export interface EmailTransport {
  send(email: OutboundEmail): Promise<SentInfo>;
}

/**
 * A send failed and MUST NOT be retried (e.g. invalid recipient / validation). The relay parks the
 * request in needs_review immediately.
 */
export class PermanentSendError extends Error {}
/**
 * A send failed but MAY succeed later (network / 429 rate-limit / 5xx). The relay keeps the row pending
 * and retries with bounded backoff until the attempt cap, then parks needs_review.
 */
export class TransientSendError extends Error {}

/** Offline default: records sent mail in memory. Deterministic ids for tests. */
export class InMemoryEmailTransport implements EmailTransport {
  readonly sent: Array<OutboundEmail & { messageId: string }> = [];
  async send(email: OutboundEmail): Promise<SentInfo> {
    const messageId = `mem-${this.sent.length + 1}`;
    this.sent.push({ ...email, messageId });
    return { messageId };
  }
}

/** Resend `error.name`s that are not worth retrying — the request needs a person, not another attempt. */
const PERMANENT_ERROR_NAMES = new Set([
  'validation_error',
  'invalid_from_address',
  'invalid_to_address',
  'invalid_attachment',
  'missing_required_field',
  'restricted_api_key',
  'not_found',
]);

/**
 * Outbound via the official Resend SDK (D21). The SDK returns `{ data, error }` (it does not throw for
 * API errors); we map a present `error` to a typed Permanent/Transient failure so the relay can decide
 * retry-vs-park. The provider message id is `data.id`. The API key is never logged.
 */
export class ResendTransport implements EmailTransport {
  private readonly client: Resend;
  constructor(apiKey: string, private readonly from: string) {
    this.client = new Resend(apiKey);
  }
  async send(email: OutboundEmail): Promise<SentInfo> {
    let data: { id: string } | null;
    let error: { name?: string; message?: string } | null;
    try {
      const res = await this.client.emails.send(
        {
          from: this.from,
          to: email.to,
          subject: email.subject,
          text: email.body,
          ...(email.html ? { html: email.html } : {}),
          ...(email.replyTo ? { replyTo: email.replyTo } : {}),
          ...(email.headers ? { headers: email.headers } : {}),
        },
        ...(email.idempotencyKey ? [{ idempotencyKey: email.idempotencyKey }] : []),
      );
      data = res.data;
      error = res.error;
    } catch {
      // Network-level fault (the SDK only throws here) — always retryable. No details logged (VII).
      throw new TransientSendError('resend network error');
    }
    if (error || !data) {
      const name = error?.name ?? 'unknown_error';
      if (PERMANENT_ERROR_NAMES.has(name)) throw new PermanentSendError(name);
      throw new TransientSendError(name); // rate_limit_exceeded / *_server_error / unknown → retry
    }
    return { messageId: data.id };
  }
}
