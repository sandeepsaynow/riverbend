import { Resend } from 'resend';

/**
 * Received-email content fetch (D21). The `email.received` webhook carries metadata only; the full body
 * and headers must be retrieved from the Receiving API. Behind a port so the worker can inject a
 * deterministic fake in tests (no network, no credentials).
 */
export interface ReceivedEmail {
  messageId: string; // RFC Message-ID (per-shop de-dup key)
  to: string[]; // recipients — the reply+<token>@ address is here
  from: string; // bare sender address (never trusted alone, D21/FR-013)
  text: string;
  html?: string;
  authentication?: { spf?: string; dkim?: string; dmarc?: string };
}
export interface ReceivingClient {
  get(emailId: string): Promise<ReceivedEmail>;
}

/** One entry from the Receiving list (metadata only — no body; content via `get`). */
export interface ReceivedEmailSummary {
  id: string; // Resend receiving email id — the poll de-dup key + the cursor value
  messageId: string;
  createdAt: string;
}
/** List capability for polling-mode inbound (D21.1). Separate from `ReceivingClient` so webhook-only
 *  consumers (and their tests) don't depend on `list`. `ResendReceiving` implements both. */
export interface ReceivingLister {
  list(after?: string, limit?: number): Promise<{ emails: ReceivedEmailSummary[]; hasMore: boolean }>;
}

/** Live adapter over `resend.emails.receiving` (`get` + `list`). */
export class ResendReceiving implements ReceivingClient, ReceivingLister {
  private readonly client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }
  async list(after?: string, limit = 100): Promise<{ emails: ReceivedEmailSummary[]; hasMore: boolean }> {
    const { data, error } = await this.client.emails.receiving.list({ limit, ...(after ? { after } : {}) });
    if (error || !data) throw new Error('receiving.list failed'); // no PII logged (VII)
    const emails = data.data.map((e) => ({ id: e.id, messageId: e.message_id, createdAt: e.created_at }));
    return { emails, hasMore: data.has_more };
  }
  async get(emailId: string): Promise<ReceivedEmail> {
    const { data, error } = await this.client.emails.receiving.get(emailId);
    if (error || !data) throw new Error('receiving.get failed'); // no PII in the message (VII)
    const d = data as unknown as {
      message_id?: string;
      to?: string[];
      from?: string;
      text?: string | null;
      html?: string;
      authentication?: { spf?: string; dkim?: string; dmarc?: string };
    };
    return {
      messageId: d.message_id ?? emailId,
      to: Array.isArray(d.to) ? d.to : [],
      from: d.from ?? '',
      text: d.text ?? '',
      ...(d.html ? { html: d.html } : {}),
      ...(d.authentication ? { authentication: d.authentication } : {}),
    };
  }
}
