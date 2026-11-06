import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { EmailService } from '../../src/modules/email/index.js';
import { mintReplyToken } from '../../src/modules/email/tokens.js';
import { InMemoryEmailTransport } from '../../src/modules/email/transport.js';
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
    router: {
      resolveShopByInboundAddress: (a) => shops.resolveByInboundAddress(a),
      resolveShopByContent: (text) => shops.resolveShopByContent(text),
    },
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
    expect(await email.handleInbound({ providerMessageId: '<u-1@mail>', toAddress: 'nobody@rb.inbound.test', toAddresses: ['nobody@rb.inbound.test'], text: 'hello?' })).toBe('pending'); // D32: held for shop clarification, not dropped (no order)
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

describe('006/D31 generic-address email → content-based tenant routing (code-validated, never LLM)', () => {
  it('a generic recipient + body naming exactly one shop → routed to THAT shop', async () => {
    const dt = await shops.createShop({ slug: 'rb-downtown', timeZone: 'America/Chicago' });
    const ns = await shops.createShop({ slug: 'rb-northside', timeZone: 'America/Chicago' });
    // recipient is a generic/catch-all address that maps to no shop; the body names "Northside"
    const mail = { providerMessageId: '<d31-1@mail>', toAddress: 'hello@karoiechou.resend.app', toAddresses: ['hello@karoiechou.resend.app'], text: 'Hi, I need a flat tire repaired at Northside please.', from: 'alex@gmail.com' };
    expect(await email.handleInbound(mail)).toBe('accepted');
    expect(await requestCount(ns.id)).toBe(1); // routed to Northside by content
    expect(await requestCount(dt.id)).toBe(0); // NOT the other shop
  });

  it('a generic recipient with NO shop named → pending (held for clarification, no tenant assigned)', async () => {
    const mail = { providerMessageId: '<d31-2@mail>', toAddress: 'hello@karoiechou.resend.app', toAddresses: ['hello@karoiechou.resend.app'], text: 'My bike needs a tune-up, can you help?', from: 'alex@gmail.com' };
    expect(await email.handleInbound(mail)).toBe('pending'); // D32
  });

  it('a generic recipient naming TWO shops → ambiguous → pending (never guessed)', async () => {
    const mail = { providerMessageId: '<d31-3@mail>', toAddress: 'hello@karoiechou.resend.app', toAddresses: ['hello@karoiechou.resend.app'], text: 'Should I go to Downtown or Northside for a flat fix?', from: 'alex@gmail.com' };
    expect(await email.handleInbound(mail)).toBe('pending'); // D32
  });

  it('a shop-specific recipient address is authoritative even if the body names another shop', async () => {
    const dt2 = await shops.createShop({ slug: 'rb-downtown-x', timeZone: 'America/Chicago' });
    await shops.setInboundAddress('rb-downtown-x', 'rb-downtown-x@karoiechou.resend.app');
    const mail = { providerMessageId: '<d31-4@mail>', toAddress: 'rb-downtown-x@karoiechou.resend.app', toAddresses: ['rb-downtown-x@karoiechou.resend.app'], text: 'Flat tire — I usually go to Northside but sending here.', from: 'alex@gmail.com' };
    expect(await email.handleInbound(mail)).toBe('accepted');
    expect(await requestCount(dt2.id)).toBe(1); // routed by the trusted recipient address, not the body
  });
});

describe('006/D32 pending-intake: generic address → content shop resolution + clarification/resume', () => {
  async function ensureShop(slug: string): Promise<string> {
    const existing = await t.db.adminQuery<{ id: string }>(`SELECT id FROM shops WHERE slug=$1`, [slug]);
    if (existing.rows[0]) return existing.rows[0].id;
    return (await shops.createShop({ slug, timeZone: 'America/Chicago' })).id;
  }
  const reqCountBySlug = async (slug: string) => {
    const r = await t.db.adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM requests rq JOIN messages m ON m.id=rq.message_id JOIN shops s ON s.id=m.shop_id WHERE s.slug=$1 AND m.source='email'`, [slug]);
    return Number(r.rows[0]!.n);
  };
  const GENERIC = { toAddress: 'sandeepsudhagani@karoiechou.resend.app', toAddresses: ['sandeepsudhagani@karoiechou.resend.app'] };

  it('generic email mentioning each shop → an order for THAT shop (Downtown/Northside/Lakeshore)', async () => {
    const dt = await ensureShop('rb-downtown'); const ns = await ensureShop('rb-northside'); const lk = await ensureShop('rb-lakeshore');
    const b0 = { dt: await reqCountBySlug('rb-downtown'), ns: await reqCountBySlug('rb-northside'), lk: await reqCountBySlug('rb-lakeshore') };
    expect(await email.handleInbound({ ...GENERIC, providerMessageId: '<d32-dt@mail>', from: 'c@x.com', text: 'Flat tire fix at Downtown please.' })).toBe('accepted');
    expect(await email.handleInbound({ ...GENERIC, providerMessageId: '<d32-ns@mail>', from: 'c@x.com', text: 'Tune-up at Northside please.' })).toBe('accepted');
    expect(await email.handleInbound({ ...GENERIC, providerMessageId: '<d32-lk@mail>', from: 'c@x.com', text: 'Brake bleed at Lakeshore please.' })).toBe('accepted');
    expect(await reqCountBySlug('rb-downtown')).toBe(b0.dt + 1);
    expect(await reqCountBySlug('rb-northside')).toBe(b0.ns + 1);
    expect(await reqCountBySlug('rb-lakeshore')).toBe(b0.lk + 1);
    void dt; void ns; void lk;
  });

  it('generic email with NO shop → pending (no order), clarification sent once, reply resolves the shop → order', async () => {
    const before = await reqCountBySlug('rb-northside');
    const r = await email.handleInbound({ ...GENERIC, providerMessageId: '<d32-pend@mail>', from: 'rider@gmail.com', text: 'Hi, my bike needs a tune-up — can you help?' });
    expect(r).toBe('pending');
    const pend = await t.db.adminQuery<{ id: string; state: string; reason: string }>(`SELECT id, state, reason FROM pending_inbound_email WHERE provider_message_id='<d32-pend@mail>'`);
    expect(pend.rows[0]!.state).toBe('awaiting_shop');
    expect(pend.rows[0]!.reason).toBe('no_shop');
    expect(await reqCountBySlug('rb-northside')).toBe(before); // no order yet

    // clarification sweep sends one email to THIS sender with a reply+<pendingToken> address
    const transport = new InMemoryEmailTransport();
    await email.relayPendingClarifications(transport);
    const sent = transport.sent.find((e) => e.to === 'rider@gmail.com');
    expect(sent, 'clarification sent to the pending sender').toBeDefined();
    const token = /reply\+([^@]+)@/.exec(sent!.replyTo ?? '')![1]!;
    // a second sweep does NOT re-send to this sender (bounded via clarify_sent → no loop)
    const transport2 = new InMemoryEmailTransport();
    await email.relayPendingClarifications(transport2);
    expect(transport2.sent.some((e) => e.to === 'rider@gmail.com')).toBe(false);

    // customer replies naming the shop → resolves → creates the Northside request from the ORIGINAL body
    const reply = await email.handleInbound({ toAddress: `reply+${token}@rb.resend.app`, toAddresses: [`reply+${token}@rb.resend.app`], providerMessageId: '<d32-pend-reply@mail>', from: 'rider@gmail.com', text: 'Northside, thanks!' });
    expect(reply).toBe('accepted');
    void before;
    // The created request is under Northside, source=email, keyed on the ORIGINAL message id, original body.
    const created = await t.db.adminQuery<{ slug: string; content: string }>(
      `SELECT s.slug, m.content FROM messages m JOIN shops s ON s.id=m.shop_id WHERE m.submission_id='<d32-pend@mail>' AND m.source='email'`);
    expect(created.rows[0]!.slug).toBe('rb-northside');
    expect(created.rows[0]!.content).toContain('tune-up');
    const after = await t.db.adminQuery<{ state: string; shop: string | null }>(`SELECT state, resolved_shop_id::text AS shop FROM pending_inbound_email WHERE provider_message_id='<d32-pend@mail>'`);
    expect(after.rows[0]!.state).toBe('resolved');
    expect(after.rows[0]!.shop).not.toBeNull();
  });

  it('generic email mentioning TWO shops → pending (ambiguous), no premature order', async () => {
    const r = await email.handleInbound({ ...GENERIC, providerMessageId: '<d32-amb@mail>', from: 'c@x.com', text: 'Should I bring it to Downtown or Lakeshore for a flat fix?' });
    expect(r).toBe('pending');
    const pend = await t.db.adminQuery<{ reason: string }>(`SELECT reason FROM pending_inbound_email WHERE provider_message_id='<d32-amb@mail>'`);
    expect(pend.rows[0]!.reason).toBe('ambiguous_shop');
  });

  it('pending clarification to a no-reply/bounce sender is suppressed (abandoned, no email) — loop safety', async () => {
    await email.handleInbound({ ...GENERIC, providerMessageId: '<d32-noreply@mail>', from: 'no-reply@newsletter.com', text: 'Unsubscribe me' });
    const transport = new InMemoryEmailTransport();
    await email.relayPendingClarifications(transport);
    // No clarification is sent TO the no-reply sender (other pending rows from sibling tests may still send).
    expect(transport.sent.some((e) => e.to === 'no-reply@newsletter.com')).toBe(false);
    const pend = await t.db.adminQuery<{ state: string }>(`SELECT state FROM pending_inbound_email WHERE provider_message_id='<d32-noreply@mail>'`);
    expect(pend.rows[0]!.state).toBe('abandoned'); // suppressed, parked — never emailed
  });
});
