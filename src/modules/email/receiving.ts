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

/** Live adapter over `resend.emails.receiving.get(id)`. */
export class ResendReceiving implements ReceivingClient {
  private readonly client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
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
