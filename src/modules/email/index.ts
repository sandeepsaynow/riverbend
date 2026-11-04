import type { Db } from '../../platform/db/index.js';
import { mintReplyToken, readReplyToken } from './tokens.js';
import type { EmailTransport } from './transport.js';

export interface EmailConfig {
  signingKey: string;
  fromAddress: string;
  replyDomain: string; // e.g. "reply.riverbend.example" → reply+<token>@reply.riverbend.example
}

export type InboundResult = 'accepted' | 'duplicate' | 'unmatched' | 'ignored_not_awaiting';

export interface InboundEmail {
  providerMessageId: string;
  toAddress: string;
  inReplyTo?: string;
  references?: string;
  text: string;
}

/**
 * Email side effects (D10): outbound clarification via a transactional outbox, inbound reply
 * correlation with Message-ID de-duplication and one-round enforcement. Owns `email_outbox` /
 * `inbound_emails`; reads `follow_ups`/`requests`/`messages` (same pragmatic sharing as 003/004).
 * The model never sends email — code does (Principle I).
 */
export class EmailService {
  constructor(private readonly db: Db, private readonly cfg: EmailConfig) {}

  /** Queue the single follow-up question as an email. No email on file → park needs_review (I8). */
  async enqueueFollowUp(shopId: string, requestId: string): Promise<'queued' | 'no_reply_path' | 'no_question'> {
    return this.db.withTenant(shopId, async (c) => {
      const r = await c.query<{ question: string; email: string | null }>(
        `SELECT f.question AS question, m.customer_email AS email
           FROM follow_ups f
           JOIN requests rq ON rq.id = f.request_id
           JOIN messages m ON m.id = rq.message_id
          WHERE f.request_id = $1`,
        [requestId],
      );
      const row = r.rows[0];
      if (!row) return 'no_question';
      if (!row.email) {
        await c.query(`UPDATE requests SET state='needs_review', last_error='no_reply_path', updated_at=now() WHERE id=$1`, [requestId]);
        return 'no_reply_path';
      }
      const subject = 'A quick question about your bike repair';
      const body = `${row.question}\n\nJust reply to this email and we'll take it from there.`;
      await c.query(
        `INSERT INTO email_outbox (shop_id, request_id, to_email, subject, body, status)
         VALUES ($1,$2,$3,$4,$5,'pending')
         ON CONFLICT (request_id) DO NOTHING`,
        [shopId, requestId, row.email, subject, body],
      );
      return 'queued';
    });
  }

  /** Send pending outbound mail (cross-shop; runs in the worker). Failure → request needs_review. */
  async relayPending(transport: EmailTransport, limit = 20): Promise<{ sent: number; failed: number }> {
    const pending = await this.db.adminQuery<{ id: string; shop_id: string; request_id: string; to_email: string; subject: string; body: string }>(
      `SELECT id, shop_id, request_id, to_email, subject, body FROM email_outbox WHERE status='pending' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    let sent = 0;
    let failed = 0;
    for (const row of pending.rows) {
      const token = mintReplyToken(this.cfg.signingKey, row.shop_id, row.request_id);
      try {
        const info = await transport.send({
          to: row.to_email,
          subject: row.subject,
          body: row.body,
          replyTo: `reply+${token}@${this.cfg.replyDomain}`,
          headers: { 'X-Riverbend-Request': row.request_id },
        });
        await this.db.adminQuery(
          `UPDATE email_outbox SET status='sent', provider_message_id=$2, sent_at=now() WHERE id=$1`,
          [row.id, info.messageId],
        );
        sent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'send failed';
        await this.db.adminQuery(`UPDATE email_outbox SET status='failed', error=$2 WHERE id=$1`, [row.id, msg.slice(0, 500)]);
        // Delivery failed → the request needs a person; the work is never rolled back (D10/VI).
        await this.db.adminQuery(
          `UPDATE requests SET state='needs_review', last_error='email_delivery_failed', updated_at=now() WHERE id=$1 AND shop_id=$2`,
          [row.request_id, row.shop_id],
        );
        failed++;
      }
    }
    return { sent, failed };
  }

  /** Correlate + de-dup an inbound reply, record it, and enqueue resumption. Enforces one round. */
  async handleInbound(input: InboundEmail): Promise<InboundResult> {
    const token = this.extractToken(input);
    if (!token) return 'unmatched';
    const correlated = readReplyToken(this.cfg.signingKey, token);
    if (!correlated) return 'unmatched';
    const { shopId, requestId } = correlated;

    return this.db.withTenant(shopId, async (c) => {
      // De-dup by provider Message-ID (per shop) before any side effect.
      const dedupe = await c.query<{ id: string }>(
        `INSERT INTO inbound_emails (shop_id, request_id, provider_message_id)
         VALUES ($1,$2,$3) ON CONFLICT (shop_id, provider_message_id) DO NOTHING RETURNING id`,
        [shopId, requestId, input.providerMessageId],
      );
      if (dedupe.rows.length === 0) return 'duplicate';

      // One round: only resume a request that actually asked and is still waiting.
      const req = await c.query<{ state: string }>(`SELECT state FROM requests WHERE id=$1`, [requestId]);
      if (req.rows[0]?.state !== 'awaiting_customer') return 'ignored_not_awaiting';

      const reply = stripQuoted(input.text);
      // First reply wins (the single clarification round, I6-aligned).
      await c.query(
        `UPDATE follow_ups SET reply_content = COALESCE(reply_content, $2), replied_at = COALESCE(replied_at, now()) WHERE request_id=$1`,
        [requestId, reply],
      );
      // Resume through the normal outbox → relay → pipeline path (pipeline consumes the reply).
      await c.query(`INSERT INTO job_outbox (shop_id, request_id, status) VALUES ($1,$2,'pending')`, [shopId, requestId]);
      return 'accepted';
    });
  }

  private extractToken(input: InboundEmail): string | null {
    const haystack = `${input.toAddress} ${input.references ?? ''} ${input.inReplyTo ?? ''}`;
    const m = /reply\+([A-Za-z0-9_\-.]+)@/.exec(haystack);
    return m ? m[1]! : null;
  }
}

/** Trim a plain-text reply to the new content (drop quoted history). Best-effort, deterministic. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^>/.test(line)) break;
    if (/^On .+wrote:$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n').trim();
}
