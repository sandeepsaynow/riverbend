import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { EmailService } from '../../src/modules/email/index.js';
import { mintReplyToken } from '../../src/modules/email/tokens.js';
import type { ReceivingClient, ReceivedEmail } from '../../src/modules/email/receiving.js';

// 006/D25 — a brand-NEW inbound customer email (no reply token) must create a new request, attributed to
// the shop that owns the VERIFIED destination address (never the sender). Reply-token resumption (B) and
// new-inbound intake (A) must never be confused. No Resend credentials/network — a fake Receiving client.
const KEY = 'test-email-signing-key';
const CFG = { signingKey: KEY, fromAddress: 'rb <onboarding@resend.dev>', replyDomain: 'rb.resend.app', maxSendAttempts: 2 };

class FakeReceiving implements ReceivingClient {
  private readonly box = new Map<string, ReceivedEmail>();
  put(id: string, mail: ReceivedEmail): void { this.box.set(id, mail); }
  async get(id: string): Promise<ReceivedEmail> {
    const m = this.box.get(id);
    if (!m) throw new Error(`no such email: ${id}`);
    return m;
  }
}

let t: TestDb;
let shops: ShopsService;
let email: EmailService;

async function shopWithAddress(slug: string, addr: string): Promise<string> {
  const s = await shops.createShop({ slug, timeZone: 'America/Chicago' });
  await shops.setInboundAddress(slug, addr);
  return s.id;
}
async function requestCount(shopId: string): Promise<number> {
  const r = await t.db.adminQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM requests rq JOIN messages m ON m.id=rq.message_id WHERE m.shop_id=$1`,
    [shopId],
  );
  return Number(r.rows[0]!.n);
}

beforeAll(async () => {
  t = await startTestDb();
  shops = new ShopsService(t.db);
  email = new EmailService(t.db, CFG, {
    router: { resolveShopByInboundAddress: (a) => shops.resolveByInboundAddress(a) },
    intake: new IntakeService(t.db),
  });
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('006/D25 new inbound email → new request', () => {
  it('a brand-new email to a shop address creates exactly one request; a provider retry (same Message-ID) does not duplicate', async () => {
    const shop = await shopWithAddress('rb-in-a', 'intake-a@rb.inbound.test');
    const mail = { providerMessageId: '<new-1@mail>', toAddress: 'intake-a@rb.inbound.test', toAddresses: ['intake-a@rb.inbound.test'], text: 'My chain skips under load, can you fix it?', from: 'rider@example.com' };
    expect(await email.handleInbound(mail)).toBe('accepted');

    const rows = await t.db.adminQuery<{ source: string; customer_email: string | null; content: string }>(
      `SELECT m.source, m.customer_email, m.content FROM requests rq JOIN messages m ON m.id=rq.message_id WHERE m.shop_id=$1`, [shop]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.source).toBe('email');
    expect(rows.rows[0]!.customer_email).toBe('rider@example.com'); // sender recorded as the reply path
    expect(rows.rows[0]!.content).toContain('chain skips');

    // Same provider Message-ID again (retry, or webhook+poll overlap) → idempotent, no second request.
    expect(await email.handleInbound(mail)).toBe('duplicate');
    expect(await requestCount(shop)).toBe(1);
  });

  it('two distinct emails with identical bodies → two requests (identifier dedup, never content-hash)', async () => {
    const shop = await shopWithAddress('rb-in-b', 'intake-b@rb.inbound.test');
    const base = { toAddress: 'intake-b@rb.inbound.test', toAddresses: ['intake-b@rb.inbound.test'], text: 'flat tire please help' };
    expect(await email.handleInbound({ ...base, providerMessageId: '<b-1@mail>' })).toBe('accepted');
    expect(await email.handleInbound({ ...base, providerMessageId: '<b-2@mail>' })).toBe('accepted');
    expect(await requestCount(shop)).toBe(2);
  });

  it('routes by the destination address, not the sender — a spoofed From cannot change the tenant', async () => {
    const a = await shopWithAddress('rb-in-e', 'intake-e@rb.inbound.test');
    const b = await shopWithAddress('rb-in-f', 'intake-f@rb.inbound.test');
    expect(await email.handleInbound({ providerMessageId: '<e-1@mail>', toAddress: 'intake-e@rb.inbound.test', toAddresses: ['intake-e@rb.inbound.test'], text: 'tune up', from: 'spoofer@evil.test' })).toBe('accepted');
    expect(await requestCount(a)).toBe(1);
    expect(await requestCount(b)).toBe(0);
  });

  it('an unknown/unconfigured recipient creates nothing (safe ignore — no tenant to attribute)', async () => {
    expect(await email.handleInbound({ providerMessageId: '<u-1@mail>', toAddress: 'nobody@rb.inbound.test', toAddresses: ['nobody@rb.inbound.test'], text: 'hello?' })).toBe('unmatched');
  });

  it('an email addressed to two different shops is ambiguous → safe ignore, nothing created', async () => {
    const c = await shopWithAddress('rb-in-c', 'intake-c@rb.inbound.test');
    const d = await shopWithAddress('rb-in-d', 'intake-d@rb.inbound.test');
    const res = await email.handleInbound({ providerMessageId: '<amb-1@mail>', toAddress: 'intake-c@rb.inbound.test', toAddresses: ['intake-c@rb.inbound.test', 'intake-d@rb.inbound.test'], text: 'who gets this?' });
    expect(res).toBe('unmatched');
    expect(await requestCount(c)).toBe(0);
    expect(await requestCount(d)).toBe(0);
  });

  it('HTML-only email (no text part) still yields a request with text recovered from the HTML', async () => {
    const shop = await shopWithAddress('rb-in-g', 'intake-g@rb.inbound.test');
    expect(await email.handleInbound({ providerMessageId: '<g-1@mail>', toAddress: 'intake-g@rb.inbound.test', toAddresses: ['intake-g@rb.inbound.test'], text: '', html: '<p>Brake lever is <b>loose</b></p>' })).toBe('accepted');
    const row = await t.db.adminQuery<{ content: string }>(`SELECT content FROM messages WHERE shop_id=$1`, [shop]);
    expect(row.rows[0]!.content).toContain('Brake lever is loose');
  });

  it('an empty email creates nothing', async () => {
    const shop = await shopWithAddress('rb-in-h', 'intake-h@rb.inbound.test');
    expect(await email.handleInbound({ providerMessageId: '<h-1@mail>', toAddress: 'intake-h@rb.inbound.test', toAddresses: ['intake-h@rb.inbound.test'], text: '   ' })).toBe('unmatched');
    expect(await requestCount(shop)).toBe(0);
  });

  it('a reply+ token still resumes the existing request — reply (B) wins over new-inbound (A)', async () => {
    const shop = await shopWithAddress('rb-in-i', 'intake-i@rb.inbound.test');
    const sub = await new IntakeService(t.db).submit({ shopId: shop, source: 'web', submissionId: 'ri-1', content: 'brakes', customerEmail: 'r@x.test' });
    await t.db.adminQuery(`UPDATE requests SET state='awaiting_customer' WHERE id=$1`, [sub.requestId]);
    await t.db.adminQuery(`INSERT INTO follow_ups (shop_id, request_id, question) VALUES ($1,$2,'which?')`, [shop, sub.requestId]);
    const token = mintReplyToken(KEY, shop, sub.requestId);
    expect(await email.handleInbound({ providerMessageId: '<i-1@mail>', toAddress: `reply+${token}@rb.resend.app`, toAddresses: [`reply+${token}@rb.resend.app`], text: 'replace pads' })).toBe('accepted');
    expect(await requestCount(shop)).toBe(1); // resumed the existing request, did NOT create a second
    const fu = await t.db.adminQuery<{ reply_content: string }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [sub.requestId]);
    expect(fu.rows[0]!.reply_content).toBe('replace pads');
  });

  it('the worker event-drain path (fetch content → correlate) creates a request from a new inbound email', async () => {
    const shop = await shopWithAddress('rb-in-j', 'intake-j@rb.inbound.test');
    const recv = new FakeReceiving();
    recv.put('re-j1', { messageId: '<j-1@mail>', to: ['intake-j@rb.inbound.test'], from: 'rider@example.com', text: 'my wheel is wobbly' });
    expect(await email.ingestEvent('svix-j1', 'email.received', 're-j1')).toBe('accepted');
    const r = await email.processPendingEvents(recv);
    expect(r.processed).toBe(1);
    const row = await t.db.adminQuery<{ source: string; content: string }>(
      `SELECT m.source, m.content FROM requests rq JOIN messages m ON m.id=rq.message_id WHERE m.shop_id=$1`, [shop]);
    expect(row.rows[0]!.source).toBe('email');
    expect(row.rows[0]!.content).toContain('wobbly');
  });
});
