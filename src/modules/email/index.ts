import type { Db } from '../../platform/db/index.js';
import { mintReplyToken, readReplyToken } from './tokens.js';
import { PermanentSendError, type EmailTransport } from './transport.js';
import type { ReceivingClient, ReceivingLister } from './receiving.js';

export interface PollResult {
  skipped?: true; // another poller holds the lease
  discovered?: number; // newly-seen emails recorded this tick
  scanned?: number; // emails examined this tick (incl. already-seen)
  pages?: number;
}
export interface PollOptions {
  maxPages?: number; // bound the scan per tick (default 10)
  pageLimit?: number; // Resend list page size, 1–100 (default 100)
  leaseSeconds?: number; // single-flight lease duration (default 55)
}

export interface EmailConfig {
  signingKey: string;
  fromAddress: string;
  replyDomain: string; // e.g. "<id>.resend.app" → reply+<token>@<id>.resend.app (a Resend receiving domain)
  maxSendAttempts?: number; // bounded outbound retry before needs_review (default 5)
}

export type InboundResult = 'accepted' | 'duplicate' | 'unmatched' | 'ignored_not_awaiting';
export type EventResult = 'processed' | 'ignored' | 'error';

export interface InboundEmail {
  providerMessageId: string;
  toAddress: string;
  inReplyTo?: string;
  references?: string;
  text: string;
}

const MAX_INBOUND_TEXT = 50_000; // bound customer-controlled body size (D21/FR-013)

/**
 * Email side effects (D10 → D21, Resend sole provider): outbound clarification via a transactional
 * outbox (Resend SDK, idempotent, bounded retry); inbound replies via a durable provider-event log
 * (`email_events`, de-dup by svix-id) processed asynchronously by the worker — fetch content from the
 * Receiving API, then correlate with Message-ID de-dup and one-round enforcement. Owns `email_outbox` /
 * `inbound_emails` / `email_events`; reads `follow_ups`/`requests`/`messages`. The model never sends
 * email — code does (Principle I). Secrets and email content are never logged (VII).
 */
export class EmailService {
  private readonly maxSendAttempts: number;
  constructor(private readonly db: Db, private readonly cfg: EmailConfig) {
    this.maxSendAttempts = cfg.maxSendAttempts ?? 5;
  }

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
      const html = `<p>${escapeHtml(row.question)}</p><p>Just reply to this email and we'll take it from there.</p>`;
      await c.query(
        `INSERT INTO email_outbox (shop_id, request_id, to_email, subject, body, html, idempotency_key, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
         ON CONFLICT (request_id) DO NOTHING`,
        [shopId, requestId, row.email, subject, body, html, `rb-followup-${requestId}`],
      );
      return 'queued';
    });
  }

  /**
   * Send pending outbound mail (cross-shop; runs in the worker). Transient failure keeps the row
   * pending with bounded backoff; permanent failure (or exhausted retries) → failed + needs_review.
   * A worker crash never loses a send: the row stays durable/`pending`.
   */
  async relayPending(transport: EmailTransport, limit = 20): Promise<{ sent: number; failed: number; retried: number }> {
    const pending = await this.db.adminQuery<{
      id: string; shop_id: string; request_id: string; to_email: string; subject: string; body: string; html: string | null; idempotency_key: string | null; attempts: number;
    }>(
      `SELECT id, shop_id, request_id, to_email, subject, body, html, idempotency_key, attempts
         FROM email_outbox
        WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at LIMIT $1`,
      [limit],
    );
    let sent = 0;
    let failed = 0;
    let retried = 0;
    for (const row of pending.rows) {
      const token = mintReplyToken(this.cfg.signingKey, row.shop_id, row.request_id);
      try {
        const info = await transport.send({
          to: row.to_email,
          subject: row.subject,
          body: row.body,
          ...(row.html ? { html: row.html } : {}),
          replyTo: `reply+${token}@${this.cfg.replyDomain}`,
          headers: { 'X-Riverbend-Request': row.request_id },
          ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
        });
        await this.db.adminQuery(
          `UPDATE email_outbox SET status='sent', delivery_status='sent', provider_message_id=$2, sent_at=now() WHERE id=$1`,
          [row.id, info.messageId],
        );
        sent++;
      } catch (err) {
        const attempts = row.attempts + 1;
        const permanent = err instanceof PermanentSendError;
        const reason = err instanceof Error ? err.message.slice(0, 200) : 'send failed';
        if (permanent || attempts >= this.maxSendAttempts) {
          await this.db.adminQuery(`UPDATE email_outbox SET status='failed', attempts=$2, failure_reason=$3 WHERE id=$1`, [row.id, attempts, reason]);
          // Delivery failed → the request needs a person; the work is never rolled back (D10/VI).
          await this.db.adminQuery(
            `UPDATE requests SET state='needs_review', last_error='email_delivery_failed', updated_at=now() WHERE id=$1 AND shop_id=$2`,
            [row.request_id, row.shop_id],
          );
          failed++;
        } else {
          // Capped exponential backoff; the row stays pending and is retried on a later tick.
          const backoffSec = Math.min(60 * 2 ** (attempts - 1), 3600);
          await this.db.adminQuery(
            `UPDATE email_outbox SET attempts=$2, next_attempt_at = now() + ($3 || ' seconds')::interval WHERE id=$1`,
            [row.id, attempts, String(backoffSec)],
          );
          retried++;
        }
      }
    }
    return { sent, failed, retried };
  }

  /**
   * Durably record a verified provider event BEFORE acknowledging the webhook (D21/FR-011). De-duped by
   * Svix delivery id (`svix-id`), which is reused across provider retries. No address/subject/body is
   * stored (VII). The worker processes it asynchronously.
   */
  async ingestEvent(svixId: string, eventType: string, resendEmailId?: string): Promise<'accepted' | 'duplicate'> {
    const r = await this.db.adminQuery<{ id: string }>(
      `INSERT INTO email_events (svix_id, event_type, resend_email_id) VALUES ($1,$2,$3)
       ON CONFLICT (svix_id) DO NOTHING RETURNING id`,
      [svixId, eventType, resendEmailId ?? null],
    );
    return r.rows.length ? 'accepted' : 'duplicate';
  }

  /**
   * Drain unprocessed provider events (worker). For `email.received`, fetch full content from the
   * Receiving API then correlate; for delivery events, update send status. Retrying a failed event
   * never duplicates work (correlation is idempotent). Bounded per-event attempts.
   */
  async processPendingEvents(receiving: ReceivingClient, limit = 20): Promise<{ processed: number; ignored: number; errored: number }> {
    const pending = await this.db.adminQuery<{ id: string; event_type: string; resend_email_id: string | null; attempts: number }>(
      `SELECT id, event_type, resend_email_id, attempts FROM email_events WHERE status='pending' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    let processed = 0;
    let ignored = 0;
    let errored = 0;
    for (const ev of pending.rows) {
      try {
        if (!ev.resend_email_id) {
          await this.markEvent(ev.id, 'ignored', 'no_email_id');
          ignored++;
          continue;
        }
        if (ev.event_type === 'email.received') {
          const mail = await receiving.get(ev.resend_email_id);
          const toAddress = mail.to.find((a) => /reply\+/.test(a)) ?? mail.to[0] ?? '';
          const result = await this.handleInbound({
            providerMessageId: mail.messageId,
            toAddress,
            text: mail.text.slice(0, MAX_INBOUND_TEXT),
          });
          const outcome: EventResult = result === 'accepted' || result === 'duplicate' ? 'processed' : 'ignored';
          await this.markEvent(ev.id, outcome, result);
          outcome === 'processed' ? processed++ : ignored++;
        } else {
          await this.applyDeliveryStatus(ev.resend_email_id, ev.event_type);
          await this.markEvent(ev.id, 'processed', ev.event_type);
          processed++;
        }
      } catch {
        const attempts = ev.attempts + 1;
        if (attempts >= this.maxSendAttempts) {
          await this.markEvent(ev.id, 'error', 'max_attempts');
          errored++;
        } else {
          await this.db.adminQuery(`UPDATE email_events SET attempts=$2 WHERE id=$1`, [ev.id, attempts]);
        }
      }
    }
    return { processed, ignored, errored };
  }

  /**
   * Poll the Resend Receiving API for new inbound emails (D21.1 — the default local/MVP inbound path; no
   * webhook/URL/tunnel). Single-flight via a durable DB lease; discovers each email id into `email_events`
   * (de-dup by id) BEFORE advancing the checkpoint; paginates with bounded pages; order-independent (dedup
   * is the source of truth). The worker then runs `processPendingEvents` to fetch content + correlate. On a
   * list/API error the lease is released WITHOUT advancing and the tick fails so the next one retries.
   */
  async pollOnce(lister: ReceivingLister, opts: PollOptions = {}): Promise<PollResult> {
    const maxPages = opts.maxPages ?? 10;
    const pageLimit = opts.pageLimit ?? 100;
    const leaseSeconds = opts.leaseSeconds ?? 55;

    const claim = await this.tryClaimPoll(leaseSeconds);
    if (!claim) return { skipped: true };

    let discovered = 0;
    let scanned = 0;
    let pages = 0;
    let after: string | undefined;
    let newest = claim.lastCreatedAt;
    try {
      while (pages < maxPages) {
        const { emails, hasMore } = await lister.list(after, pageLimit);
        pages++;
        if (emails.length === 0) break;
        for (const e of emails) {
          scanned++;
          // Persist the provider id BEFORE advancing the checkpoint (dedup makes rediscovery a no-op).
          const res = await this.ingestEvent(`poll:${e.id}`, 'email.received', e.id);
          if (res === 'accepted') discovered++;
          if (!newest || e.createdAt > newest) newest = e.createdAt;
          after = e.id;
        }
        if (!hasMore) break;
      }
      await this.db.adminQuery(
        `UPDATE email_poll_state SET last_created_at=$1, last_email_id=$2, claimed_until=NULL, updated_at=now() WHERE id=true`,
        [newest ?? null, after ?? claim.lastEmailId ?? null],
      );
      return { discovered, scanned, pages };
    } catch (err) {
      // Release the lease without advancing — discovered ids are durable and de-dup on the next tick.
      await this.db.adminQuery(`UPDATE email_poll_state SET claimed_until=NULL, updated_at=now() WHERE id=true`);
      throw err instanceof Error ? err : new Error('poll failed');
    }
  }

  /** Atomically claim the single-flight poll lease; null if another poller holds it (FR-018). */
  private async tryClaimPoll(leaseSeconds: number): Promise<{ lastCreatedAt: string | null; lastEmailId: string | null } | null> {
    const r = await this.db.adminQuery<{ last_created_at: string | null; last_email_id: string | null }>(
      `UPDATE email_poll_state
          SET claimed_until = now() + ($1 || ' seconds')::interval, updated_at = now()
        WHERE id = true AND (claimed_until IS NULL OR claimed_until <= now())
        RETURNING last_created_at, last_email_id`,
      [String(leaseSeconds)],
    );
    const row = r.rows[0];
    return row ? { lastCreatedAt: row.last_created_at, lastEmailId: row.last_email_id } : null;
  }

  private async markEvent(id: string, status: EventResult, detail: string): Promise<void> {
    await this.db.adminQuery(`UPDATE email_events SET status=$2, processed_at=now(), detail=$3 WHERE id=$1`, [id, status, detail.slice(0, 200)]);
  }

  /**
   * Apply a delivery lifecycle event to the matching outbox row (correlated by provider id). Monotonic:
   * a terminal status (delivered/bounced/failed) is sticky, so duplicate or out-of-order events never
   * corrupt status. An API-200 alone is NOT "delivered" — only the `delivered` event sets it (FR-014).
   */
  async applyDeliveryStatus(resendEmailId: string, eventType: string): Promise<void> {
    const map: Record<string, string> = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.bounced': 'bounced',
      'email.failed': 'failed',
      'email.delivery_delayed': 'delayed',
    };
    const status = map[eventType];
    if (!status) return;
    await this.db.adminQuery(
      `UPDATE email_outbox
          SET delivery_status=$2,
              delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
              failure_reason = CASE WHEN $2 IN ('bounced','failed') THEN $2 ELSE failure_reason END
        WHERE provider_message_id=$1
          AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered','bounced','failed'))`,
      [resendEmailId, status],
    );
  }

  /** Correlate + de-dup an inbound reply, record it, and enqueue resumption. Enforces one round. */
  async handleInbound(input: InboundEmail): Promise<InboundResult> {
    const token = this.extractToken(input);
    if (!token) return 'unmatched';
    const correlated = readReplyToken(this.cfg.signingKey, token);
    if (!correlated) return 'unmatched';
    const { shopId, requestId } = correlated;

    return this.db.withTenant(shopId, async (c) => {
      // One round: only resume a request that actually asked and is still waiting. This runs under the
      // signed shop's tenant, so a token whose (shop, request) pair does not co-exist — e.g. an attempt
      // to aim a reply at another tenant's request — finds no row and is ignored (no cross-tenant write).
      const req = await c.query<{ state: string }>(`SELECT state FROM requests WHERE id=$1`, [requestId]);
      if (req.rows[0]?.state !== 'awaiting_customer') return 'ignored_not_awaiting';

      // De-dup by provider Message-ID (per shop) before the side effects.
      const dedupe = await c.query<{ id: string }>(
        `INSERT INTO inbound_emails (shop_id, request_id, provider_message_id)
         VALUES ($1,$2,$3) ON CONFLICT (shop_id, provider_message_id) DO NOTHING RETURNING id`,
        [shopId, requestId, input.providerMessageId],
      );
      if (dedupe.rows.length === 0) return 'duplicate';

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

/** Minimal HTML escaping for the outbound body (the question is customer/model-derived text). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
