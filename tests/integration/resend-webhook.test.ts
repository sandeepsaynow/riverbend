import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Webhook } from 'svix';
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
import { SvixVerifier } from '../../src/modules/email/resend-webhook.js';
import type { ReceivingClient, ReceivedEmail } from '../../src/modules/email/receiving.js';
import type { Config } from '../../src/platform/config/index.js';

const KEY = 'test-email-signing-key';
const WHSEC = `whsec_${Buffer.from('resend-svix-test-secret-0123456789').toString('base64')}`;
const CFG = { signingKey: KEY, fromAddress: 'rb <onboarding@resend.dev>', replyDomain: 'rb.resend.app', maxSendAttempts: 3 };

const wh = new Webhook(WHSEC);
/** Sign a payload exactly as Resend/Svix would, returning the three headers. */
function signed(id: string, payload: string): Record<string, string> {
  const now = new Date();
  return {
    'svix-id': id,
    'svix-timestamp': Math.floor(now.getTime() / 1000).toString(),
    'svix-signature': wh.sign(id, now, payload),
    'content-type': 'application/json',
  };
}

/** Deterministic Receiving API stand-in (no network, no credentials). */
class FakeReceiving implements ReceivingClient {
  constructor(private readonly byId: Record<string, ReceivedEmail>) {}
  async get(id: string): Promise<ReceivedEmail> {
    const e = this.byId[id];
    if (!e) throw new Error('not found');
    return e;
  }
}

let t: TestDb;
let app: Express;
let email: EmailService;
let n = 0;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
async function awaitingRequest(shopId: string): Promise<string> {
  const sub = await new IntakeService(t.db).submit({ shopId, source: 'web', submissionId: `w-${++n}`, content: 'brakes feel off', customerEmail: 'rider@example.com' });
  await t.db.adminQuery(`UPDATE requests SET state='awaiting_customer' WHERE id=$1`, [sub.requestId]);
  await t.db.adminQuery(`INSERT INTO follow_ups (shop_id, request_id, question) VALUES ($1,$2,'Which brake service?')`, [shopId, sub.requestId]);
  return sub.requestId;
}

beforeAll(async () => {
  t = await startTestDb();
  email = new EmailService(t.db, CFG);
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as unknown as Config;
  app = createApp({
    config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db),
    shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db),
    email, emailVerifier: new SvixVerifier(WHSEC),
  });
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('006/D21 — Resend webhook (Svix) ingestion', () => {
  it('rejects a missing signature (400) and a tampered signature (400)', async () => {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'x', message_id: '<a@x>' } });
    const noSig = await request(app).post('/webhooks/resend').set('content-type', 'application/json').send(body);
    expect(noSig.status).toBe(400);
    const bad = await request(app).post('/webhooks/resend').set(signed('msg_bad', body)).set('svix-signature', 'v1,deadbeef').send(body);
    expect(bad.status).toBe(400);
  });

  it('accepts a correctly signed event (200), persists it, and de-dups a replayed delivery (same svix-id)', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'pm-unknown' } });
    const headers = signed('msg_dedupe_1', body);
    const first = await request(app).post('/webhooks/resend').set(headers).send(body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('accepted');
    const again = await request(app).post('/webhooks/resend').set(headers).send(body); // same svix-id → replay
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('duplicate');
    const rows = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM email_events WHERE svix_id='msg_dedupe_1'`);
    expect(Number(rows.rows[0]!.n)).toBe(1); // recorded exactly once
  });

  it('received event → worker fetches content from the Receiving API and correlates the reply', async () => {
    const shop = await createShop('rb-wh-a');
    const reqId = await awaitingRequest(shop);
    const token = mintReplyToken(KEY, shop, reqId);
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'rcv-1', message_id: '<in-1@mail>' } });
    const res = await request(app).post('/webhooks/resend').set(signed('msg_rcv_1', body)).send(body);
    expect(res.status).toBe(200);

    // The webhook only recorded the event (metadata). The worker drains it + fetches the real content.
    const receiving = new FakeReceiving({
      'rcv-1': { messageId: '<in-1@mail>', to: [`reply+${token}@rb.resend.app`], from: 'rider@example.com', text: 'use ceramic pads\n> quoted history' },
    });
    await email.processPendingEvents(receiving);
    const fu = await t.db.adminQuery<{ reply_content: string }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [reqId]);
    expect(fu.rows[0]!.reply_content).toBe('use ceramic pads'); // fetched + quote-stripped
    const job = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM job_outbox WHERE request_id=$1`, [reqId]);
    expect(Number(job.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    const ev = await t.db.adminQuery<{ status: string }>(`SELECT status FROM email_events WHERE svix_id='msg_rcv_1'`);
    expect(ev.rows[0]!.status).toBe('processed');
  });

  it('received event whose token is forged is ignored (no work created)', async () => {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'rcv-forged', message_id: '<in-2@mail>' } });
    await request(app).post('/webhooks/resend').set(signed('msg_rcv_2', body)).send(body);
    const receiving = new FakeReceiving({
      'rcv-forged': { messageId: '<in-2@mail>', to: ['reply+not.a.real.token@rb.resend.app'], from: 'attacker@evil.example', text: 'inject' },
    });
    await email.processPendingEvents(receiving);
    const ev = await t.db.adminQuery<{ status: string; detail: string }>(`SELECT status, detail FROM email_events WHERE svix_id='msg_rcv_2'`);
    expect(ev.rows[0]!.status).toBe('ignored');
    expect(ev.rows[0]!.detail).toBe('unmatched');
  });

  it('delivery lifecycle is monotonic: delivered sticks; a late sent/bounced never regresses it', async () => {
    const shop = await createShop('rb-wh-b');
    const reqId = await awaitingRequest(shop);
    await email.enqueueFollowUp(shop, reqId);
    // Give the outbox row a known provider id to correlate against.
    await t.db.adminQuery(`UPDATE email_outbox SET status='sent', delivery_status='sent', provider_message_id='pm-77' WHERE request_id=$1`, [reqId]);

    const deliver = JSON.stringify({ type: 'email.delivered', data: { email_id: 'pm-77' } });
    await request(app).post('/webhooks/resend').set(signed('msg_deliv', deliver)).send(deliver);
    const lateBounce = JSON.stringify({ type: 'email.bounced', data: { email_id: 'pm-77' } });
    await request(app).post('/webhooks/resend').set(signed('msg_bounce_late', lateBounce)).send(lateBounce);

    const noop: ReceivingClient = { get: async () => { throw new Error('unused'); } };
    await email.processPendingEvents(noop);
    const o = await t.db.adminQuery<{ delivery_status: string; delivered_at: string | null }>(`SELECT delivery_status, delivered_at FROM email_outbox WHERE request_id=$1`, [reqId]);
    expect(o.rows[0]!.delivery_status).toBe('delivered'); // terminal 'delivered' is sticky (FR-014)
    expect(o.rows[0]!.delivered_at).not.toBeNull();
  });
});
