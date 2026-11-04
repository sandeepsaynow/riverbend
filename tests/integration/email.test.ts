import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { EmailService } from '../../src/modules/email/index.js';
import { mintReplyToken } from '../../src/modules/email/tokens.js';
import {
  InMemoryEmailTransport,
  PermanentSendError,
  TransientSendError,
  type EmailTransport,
  type OutboundEmail,
  type SentInfo,
} from '../../src/modules/email/transport.js';

// Provider-independent deterministic transports (D21/Phase J) — no Resend credentials, no network.
const KEY = 'test-email-signing-key';
const CFG = { signingKey: KEY, fromAddress: 'rb <onboarding@resend.dev>', replyDomain: 'rb.resend.app', maxSendAttempts: 2 };

class PermanentTransport implements EmailTransport {
  async send(_e: OutboundEmail): Promise<SentInfo> { throw new PermanentSendError('invalid_to_address'); }
}
class TransientTransport implements EmailTransport {
  async send(_e: OutboundEmail): Promise<SentInfo> { throw new TransientSendError('rate_limit_exceeded'); }
}

let t: TestDb;
let email: EmailService;
let n = 0;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
/** A request parked at awaiting_customer with a follow-up + an email on file. */
async function awaitingRequest(shopId: string, emailAddr: string | null): Promise<string> {
  const sub = await new IntakeService(t.db).submit({ shopId, source: 'web', submissionId: `e-${++n}`, content: 'brakes feel off', ...(emailAddr ? { customerEmail: emailAddr } : {}) });
  await t.db.adminQuery(`UPDATE requests SET state='awaiting_customer' WHERE id=$1`, [sub.requestId]);
  await t.db.adminQuery(`INSERT INTO follow_ups (shop_id, request_id, question) VALUES ($1,$2,'Which brake service?')`, [shopId, sub.requestId]);
  return sub.requestId;
}

beforeAll(async () => {
  t = await startTestDb();
  email = new EmailService(t.db, CFG);
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('006/D21 email — outbound via Resend transport', () => {
  it('enqueues the one question with a sanitised HTML body + stable idempotency key; relays to sent', async () => {
    const shop = await createShop('rb-mail-a');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    expect(await email.enqueueFollowUp(shop, reqId)).toBe('queued');
    const row = await t.db.adminQuery<{ html: string; idempotency_key: string }>(`SELECT html, idempotency_key FROM email_outbox WHERE request_id=$1`, [reqId]);
    expect(row.rows[0]!.html).toContain('<p>'); // HTML alternative present
    expect(row.rows[0]!.idempotency_key).toBe(`rb-followup-${reqId}`); // retries never double-send (I6/FR-009)

    const transport = new InMemoryEmailTransport();
    const res = await email.relayPending(transport);
    expect(res.sent).toBe(1);
    expect(transport.sent[0]!.to).toBe('rider@example.com');
    expect(transport.sent[0]!.replyTo).toMatch(/^reply\+.+@rb\.resend\.app$/);
    expect(transport.sent[0]!.idempotencyKey).toBe(`rb-followup-${reqId}`);
    const st = await t.db.adminQuery<{ status: string; delivery_status: string }>(`SELECT status, delivery_status FROM email_outbox WHERE request_id=$1`, [reqId]);
    expect(st.rows[0]!.status).toBe('sent');
    expect(st.rows[0]!.delivery_status).toBe('sent'); // not "delivered" until a delivered event (FR-014)
  });

  it('a send accepted by the provider then a lost status update is retried with the SAME idempotency key', async () => {
    // Models FR-009: if Resend accepts the send (200 + id) but the DB status write is lost (crash), the
    // row stays pending and the next relay re-sends with the SAME idempotency key → the provider dedupes
    // (24h), so no duplicate email. We capture the key seen on each send and assert it is stable.
    const shop = await createShop('rb-mail-idem');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    await email.enqueueFollowUp(shop, reqId);
    const seen: Array<string | undefined> = [];
    const capturing: EmailTransport = { async send(e) { seen.push(e.idempotencyKey); return { messageId: 'pm-stable' }; } };
    await email.relayPending(capturing);
    // Simulate the status update being lost after the provider accepted it.
    await t.db.adminQuery(`UPDATE email_outbox SET status='pending', provider_message_id=NULL, next_attempt_at=NULL WHERE request_id=$1`, [reqId]);
    await email.relayPending(capturing);
    expect(seen).toEqual([`rb-followup-${reqId}`, `rb-followup-${reqId}`]); // stable key on both attempts
  });

  it('no email on file → needs_review (no reply path, I8)', async () => {
    const shop = await createShop('rb-mail-b');
    const reqId = await awaitingRequest(shop, null);
    expect(await email.enqueueFollowUp(shop, reqId)).toBe('no_reply_path');
    const st = await t.db.adminQuery<{ state: string; last_error: string }>(`SELECT state, last_error FROM requests WHERE id=$1`, [reqId]);
    expect(st.rows[0]!.state).toBe('needs_review');
    expect(st.rows[0]!.last_error).toBe('no_reply_path');
  });

  it('permanent send failure → failed + needs_review immediately (D10/VI), not retried', async () => {
    const shop = await createShop('rb-mail-c');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    await email.enqueueFollowUp(shop, reqId);
    const res = await email.relayPending(new PermanentTransport());
    expect(res.failed).toBe(1);
    expect(res.retried).toBe(0);
    const st = await t.db.adminQuery<{ state: string; last_error: string; o_status: string }>(
      `SELECT r.state, r.last_error, o.status AS o_status FROM requests r JOIN email_outbox o ON o.request_id=r.id WHERE r.id=$1`, [reqId]);
    expect(st.rows[0]!.o_status).toBe('failed');
    expect(st.rows[0]!.state).toBe('needs_review');
    expect(st.rows[0]!.last_error).toBe('email_delivery_failed');
  });

  it('transient failures keep the row pending with bounded backoff, then park after the attempt cap', async () => {
    const shop = await createShop('rb-mail-d');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    await email.enqueueFollowUp(shop, reqId);

    const first = await email.relayPending(new TransientTransport());
    expect(first.retried).toBe(1); // still pending, attempts=1, next_attempt_at in the future
    const mid = await t.db.adminQuery<{ status: string; attempts: number }>(`SELECT status, attempts FROM email_outbox WHERE request_id=$1`, [reqId]);
    expect(mid.rows[0]!.status).toBe('pending');
    expect(mid.rows[0]!.attempts).toBe(1);

    // Force the backoff window to elapse, then the 2nd attempt hits the cap (maxSendAttempts=2) → park.
    await t.db.adminQuery(`UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE request_id=$1`, [reqId]);
    const second = await email.relayPending(new TransientTransport());
    expect(second.failed).toBe(1);
    const st = await t.db.adminQuery<{ state: string; o_status: string }>(
      `SELECT r.state, o.status AS o_status FROM requests r JOIN email_outbox o ON o.request_id=r.id WHERE r.id=$1`, [reqId]);
    expect(st.rows[0]!.o_status).toBe('failed');
    expect(st.rows[0]!.state).toBe('needs_review');
  });
});

describe('006/D21 email — inbound reply correlation (fed by fetched content)', () => {
  it('correlates a signed reply, strips quotes, records it, enqueues resumption; dedups by Message-ID', async () => {
    const shop = await createShop('rb-mail-e');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    const token = mintReplyToken(KEY, shop, reqId);
    const inbound = { providerMessageId: '<p-1@mail>', toAddress: `reply+${token}@rb.resend.app`, text: 'please replace the pads\n> On Tue, you wrote:\n> Which brake service?' };
    expect(await email.handleInbound(inbound)).toBe('accepted');
    const fu = await t.db.adminQuery<{ reply_content: string }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [reqId]);
    expect(fu.rows[0]!.reply_content).toBe('please replace the pads'); // quoted history stripped
    const job = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM job_outbox WHERE request_id=$1`, [reqId]);
    expect(Number(job.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    expect(await email.handleInbound(inbound)).toBe('duplicate'); // same Message-ID → no double resume
  });

  it('forged token → unmatched; reply to a non-waiting request → ignored (one round)', async () => {
    const shop = await createShop('rb-mail-f');
    expect(await email.handleInbound({ providerMessageId: '<p-2@mail>', toAddress: 'reply+bogus.sig@rb.resend.app', text: 'hi' })).toBe('unmatched');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    await t.db.adminQuery(`UPDATE requests SET state='extracted' WHERE id=$1`, [reqId]); // already resolved
    const token = mintReplyToken(KEY, shop, reqId);
    expect(await email.handleInbound({ providerMessageId: '<p-3@mail>', toAddress: `reply+${token}@rb.resend.app`, text: 'late reply' })).toBe('ignored_not_awaiting');
  });

  it('a reply token minted for shop A cannot resume a request in shop B (no cross-tenant injection)', async () => {
    const shopA = await createShop('rb-mail-g');
    const shopB = await createShop('rb-mail-h');
    const reqB = await awaitingRequest(shopB, 'rider@example.com');
    // Token signed for (shopA, reqB): readReplyToken trusts the signed shopId (shopA); the per-tenant
    // guard then finds no such request under shopA → unmatched/ignored, never touching shop B's data.
    const forged = mintReplyToken(KEY, shopA, reqB);
    const res = await email.handleInbound({ providerMessageId: '<p-x@mail>', toAddress: `reply+${forged}@rb.resend.app`, text: 'inject' });
    expect(res).toBe('ignored_not_awaiting'); // request reqB is not visible under shopA → not resumed
    const fu = await t.db.adminQuery<{ reply_content: string | null }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [reqB]);
    expect(fu.rows[0]!.reply_content).toBeNull(); // shop B untouched
  });
});
