import { Webhook } from 'svix';

/**
 * Inbound-webhook signature verification (D21). Resend signs webhooks with Svix; verification is over
 * the RAW request body with the `svix-id`/`svix-timestamp`/`svix-signature` headers. Behind a port so
 * routes/EmailService don't hard-depend on svix and tests can sign real fixtures with the same library.
 */
export interface SvixHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}
export interface InboundWebhookVerifier {
  /** Returns the parsed event object on a valid signature, or null when verification fails. */
  verify(rawBody: string, headers: SvixHeaders): unknown | null;
}

/** Production verifier using the official `svix` library (the same scheme Resend uses). */
export class SvixVerifier implements InboundWebhookVerifier {
  private readonly wh: Webhook;
  constructor(secret: string) {
    this.wh = new Webhook(secret);
  }
  verify(rawBody: string, headers: SvixHeaders): unknown | null {
    try {
      // `verify` throws on an invalid signature / stale timestamp and returns void on success, so we
      // parse the already-verified raw bytes ourselves to hand the event object back to the caller.
      this.wh.verify(rawBody, {
        'svix-id': headers.svixId,
        'svix-timestamp': headers.svixTimestamp,
        'svix-signature': headers.svixSignature,
      });
      return JSON.parse(rawBody);
    } catch {
      return null; // invalid/missing signature, stale timestamp, or unparseable body
    }
  }
}

/** Shape we read from a verified Resend `email.*` event (defensive — unknown fields ignored). */
export interface ResendEvent {
  type: string;
  emailId?: string; // data.email_id (received: the id to fetch; delivery: the sent email's id)
}
export function parseResendEvent(payload: unknown): ResendEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { type?: unknown; data?: { email_id?: unknown; id?: unknown } };
  if (typeof p.type !== 'string') return null;
  const data = p.data ?? {};
  const emailId =
    typeof data.email_id === 'string' ? data.email_id : typeof data.id === 'string' ? data.id : undefined;
  return { type: p.type, ...(emailId ? { emailId } : {}) };
}
