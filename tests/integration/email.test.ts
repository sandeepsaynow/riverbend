import { createHmac } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { createApp } from '../../src/api/app.js';
import { createLogger } from '../../src/platform/observability/logger.js';
import { AuthService } from '../../src/modules/auth/index.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { OrdersService } from '../../src/modules/orders/index.js';
import { EmailService } from '../../src/modules/email/index.js';
import { mintReplyToken } from '../../src/modules/email/tokens.js';
import { InMemoryEmailTransport, type EmailTransport, type OutboundEmail, type SentInfo } from '../../src/modules/email/transport.js';
import type { Config } from '../../src/platform/config/index.js';

const KEY = 'test-email-signing-key';
const SECRET = 'test-webhook-secret';
const CFG = { signingKey: KEY, fromAddress: 'rb <no-reply@rb.example>', replyDomain: 'reply.rb.example' };

class FailingTransport implements EmailTransport {
  async send(_e: OutboundEmail): Promise<SentInfo> { throw new Error('smtp down'); }
}

let t: TestDb;
let app: Express;
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
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', EMAIL_WEBHOOK_SECRET: SECRET } as unknown as Config;
  app = createApp({
    config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db),
    shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db), email,
  });
}, 180_000);

afterAll(async () => { if (t) await stopTestDb(t); });

describe('006 email — outbound follow-up', () => {
  it('enqueues + relays the one question; marks it sent with a reply-to token', async () => {
    const shop = await createShop('rb-mail-a');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    expect(await email.enqueueFollowUp(shop, reqId)).toBe('queued');
    const transport = new InMemoryEmailTransport();
    const res = await email.relayPending(transport);
    expect(res.sent).toBe(1);
    expect(transport.sent[0]!.to).toBe('rider@example.com');
    expect(transport.sent[0]!.replyTo).toMatch(/^reply\+.+@reply\.rb\.example$/);
    const row = await t.db.adminQuery<{ status: string }>(`SELECT status FROM email_outbox WHERE request_id=$1`, [reqId]);
    expect(row.rows[0]!.status).toBe('sent');
  });

  it('no email on file → needs_review (no reply path, I8)', async () => {
    const shop = await createShop('rb-mail-b');
    const reqId = await awaitingRequest(shop, null);
    expect(await email.enqueueFollowUp(shop, reqId)).toBe('no_reply_path');
    const st = await t.db.adminQuery<{ state: string; last_error: string }>(`SELECT state, last_error FROM requests WHERE id=$1`, [reqId]);
    expect(st.rows[0]!.state).toBe('needs_review');
    expect(st.rows[0]!.last_error).toBe('no_reply_path');
  });

  it('failed send → request parked needs_review, not lost (D10/VI)', async () => {
    const shop = await createShop('rb-mail-c');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    await email.enqueueFollowUp(shop, reqId);
    const res = await email.relayPending(new FailingTransport());
    expect(res.failed).toBe(1);
    const st = await t.db.adminQuery<{ state: string; last_error: string }>(`SELECT state, last_error FROM requests WHERE id=$1`, [reqId]);
    expect(st.rows[0]!.state).toBe('needs_review');
    expect(st.rows[0]!.last_error).toBe('email_delivery_failed');
  });
});

describe('006 email — inbound reply correlation', () => {
  it('correlates a signed reply, strips quotes, records it, enqueues resumption; dedups by Message-ID', async () => {
    const shop = await createShop('rb-mail-d');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    const token = mintReplyToken(KEY, shop, reqId);
    const inbound = { providerMessageId: '<p-1@mail>', toAddress: `reply+${token}@reply.rb.example`, text: 'please replace the pads\n> On Tue, you wrote:\n> Which brake service?' };
    expect(await email.handleInbound(inbound)).toBe('accepted');
    const fu = await t.db.adminQuery<{ reply_content: string }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [reqId]);
    expect(fu.rows[0]!.reply_content).toBe('please replace the pads'); // quoted history stripped
    const job = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM job_outbox WHERE request_id=$1`, [reqId]);
    expect(Number(job.rows[0]!.n)).toBeGreaterThanOrEqual(1); // resumption enqueued
    expect(await email.handleInbound(inbound)).toBe('duplicate'); // same Message-ID → no double resume
  });

  it('forged token → unmatched; reply to a non-waiting request → ignored (one round)', async () => {
    const shop = await createShop('rb-mail-e');
    expect(await email.handleInbound({ providerMessageId: '<p-2@mail>', toAddress: 'reply+bogus.sig@reply.rb.example', text: 'hi' })).toBe('unmatched');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    await t.db.adminQuery(`UPDATE requests SET state='extracted' WHERE id=$1`, [reqId]); // already resolved
    const token = mintReplyToken(KEY, shop, reqId);
    expect(await email.handleInbound({ providerMessageId: '<p-3@mail>', toAddress: `reply+${token}@reply.rb.example`, text: 'late reply' })).toBe('ignored_not_awaiting');
  });
});

describe('006 email — signed inbound webhook', () => {
  it('rejects a bad signature (401) and accepts a correctly signed reply (200)', async () => {
    const shop = await createShop('rb-mail-f');
    const reqId = await awaitingRequest(shop, 'rider@example.com');
    const token = mintReplyToken(KEY, shop, reqId);
    const body = { message_id: '<wh-1@mail>', to: `reply+${token}@reply.rb.example`, text: 'replace pads' };
    const raw = JSON.stringify(body);
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');

    const bad = await request(app).post('/webhooks/email').set('content-type', 'application/json').set('x-riverbend-signature', 'deadbeef').send(body);
    expect(bad.status).toBe(401);

    const ok = await request(app).post('/webhooks/email').set('content-type', 'application/json').set('x-riverbend-signature', sig).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('accepted');
  });
});
