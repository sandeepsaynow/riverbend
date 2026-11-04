import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { EmailService } from '../../src/modules/email/index.js';
import { mintReplyToken } from '../../src/modules/email/tokens.js';
import type { ReceivingClient, ReceivingLister, ReceivedEmail, ReceivedEmailSummary } from '../../src/modules/email/receiving.js';

const KEY = 'test-email-signing-key';
const CFG = { signingKey: KEY, fromAddress: 'rb <onboarding@resend.dev>', replyDomain: 'rb.resend.app', maxSendAttempts: 3 };

/** Deterministic Resend Receiving stand-in: serves fixed pages + content; can fail the Nth list call. */
class FakeReceiver implements ReceivingClient, ReceivingLister {
  listCalls = 0;
  constructor(
    private readonly pages: ReceivedEmailSummary[][],
    private readonly content: Record<string, ReceivedEmail> = {},
    private readonly failOnCall?: number,
  ) {}
  async list(after?: string, _limit?: number): Promise<{ emails: ReceivedEmailSummary[]; hasMore: boolean }> {
    this.listCalls++;
    if (this.failOnCall && this.listCalls === this.failOnCall) throw new Error('429 rate limited');
    let idx = 0;
    if (after) {
      const found = this.pages.findIndex((p) => p.some((e) => e.id === after));
      idx = found >= 0 ? found + 1 : this.pages.length;
    }
    const page = this.pages[idx] ?? [];
    return { emails: page, hasMore: idx < this.pages.length - 1 };
  }
  async get(id: string): Promise<ReceivedEmail> {
    const e = this.content[id];
    if (!e) throw new Error('not found');
    return e;
  }
}

let t: TestDb;
let email: EmailService;
let n = 0;
const sum = (id: string, messageId: string): ReceivedEmailSummary => ({ id, messageId, createdAt: new Date(Date.now() + ++n * 1000).toISOString() });

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
async function awaitingRequest(shopId: string): Promise<string> {
  const sub = await new IntakeService(t.db).submit({ shopId, source: 'web', submissionId: `p-${++n}`, content: 'brakes feel off', customerEmail: 'rider@example.com' });
  await t.db.adminQuery(`UPDATE requests SET state='awaiting_customer' WHERE id=$1`, [sub.requestId]);
  await t.db.adminQuery(`INSERT INTO follow_ups (shop_id, request_id, question) VALUES ($1,$2,'Which brake service?')`, [shopId, sub.requestId]);
  return sub.requestId;
}
const eventCount = async (resendId: string): Promise<number> =>
  Number((await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM email_events WHERE resend_email_id=$1`, [resendId])).rows[0]!.n);
const jobCount = async (requestId: string): Promise<number> =>
  Number((await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM job_outbox WHERE request_id=$1`, [requestId])).rows[0]!.n);

beforeAll(async () => {
  t = await startTestDb();
  email = new EmailService(t.db, CFG);
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('006/D21.1 — inbound polling discovery', () => {
  it('empty receiving list → nothing discovered', async () => {
    const r = await email.pollOnce(new FakeReceiver([[]]));
    expect(r.skipped).toBeUndefined();
    expect(r.discovered).toBe(0);
    expect(r.scanned).toBe(0);
  });

  it('one valid reply → discovered, then drained end-to-end (fetch + correlate + resume); cursor persisted', async () => {
    const shop = await createShop('rb-poll-a');
    const reqId = await awaitingRequest(shop);
    const token = mintReplyToken(KEY, shop, reqId);
    const s = sum('rc-a1', '<poll-a1@mail>');
    const rec = new FakeReceiver([[s]], { 'rc-a1': { messageId: '<poll-a1@mail>', to: [`reply+${token}@rb.resend.app`], from: 'rider@example.com', text: 'ceramic pads please\n> quoted' } });
    const baseJobs = await jobCount(reqId); // intake.submit already enqueued one job row
    const r = await email.pollOnce(rec);
    expect(r.discovered).toBe(1);
    await email.processPendingEvents(rec);
    const fu = await t.db.adminQuery<{ reply_content: string }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [reqId]);
    expect(fu.rows[0]!.reply_content).toBe('ceramic pads please');
    expect(await jobCount(reqId)).toBe(baseJobs + 1); // exactly one resumption enqueued
    const cur = await t.db.adminQuery<{ last_email_id: string; last_created_at: string }>(`SELECT last_email_id, last_created_at FROM email_poll_state WHERE id=true`);
    expect(cur.rows[0]!.last_email_id).toBe('rc-a1'); // durable checkpoint advanced
    expect(cur.rows[0]!.last_created_at).not.toBeNull();
    // Re-draining does not create a second resumption (work-order idempotency).
    await email.processPendingEvents(rec);
    expect(await jobCount(reqId)).toBe(baseJobs + 1);
  });

  it('paginates across multiple pages (more than one page of results)', async () => {
    const pages = [[sum('rc-p1', '<p1@m>'), sum('rc-p2', '<p2@m>')], [sum('rc-p3', '<p3@m>')]];
    const rec = new FakeReceiver(pages);
    const r = await email.pollOnce(rec);
    expect(r.scanned).toBe(3);
    expect(r.discovered).toBe(3);
    expect(r.pages).toBe(2);
    expect(rec.listCalls).toBe(2);
  });

  it('duplicate email ids are de-duped (rediscovery is a no-op)', async () => {
    const page = [sum('rc-dup', '<dup-id@m>')];
    const rec = new FakeReceiver([page]);
    const first = await email.pollOnce(rec);
    expect(first.discovered).toBe(1);
    const again = await email.pollOnce(new FakeReceiver([page]));
    expect(again.discovered).toBe(0); // already in email_events
    expect(await eventCount('rc-dup')).toBe(1);
  });

  it('a list/API failure releases the lease without advancing; the next tick succeeds', async () => {
    const rec = new FakeReceiver([[sum('rc-retry', '<retry@m>')]], {}, 1); // first list() throws
    await expect(email.pollOnce(rec)).rejects.toThrow();
    const lease = await t.db.adminQuery<{ claimed_until: string | null }>(`SELECT claimed_until FROM email_poll_state WHERE id=true`);
    expect(lease.rows[0]!.claimed_until).toBeNull(); // lease released on failure
    const r = await email.pollOnce(rec); // second call: list() now succeeds
    expect(r.discovered).toBe(1);
  });

  it('survives a worker restart: a fresh service re-reads the durable cursor and de-dups', async () => {
    const page = [sum('rc-restart', '<restart@m>')];
    await email.pollOnce(new FakeReceiver([page]));
    const freshService = new EmailService(t.db, CFG); // simulates a new worker process
    const r = await freshService.pollOnce(new FakeReceiver([page]));
    expect(r.discovered).toBe(0); // dedup is durable in the DB, not in-memory
    expect(await eventCount('rc-restart')).toBe(1);
  });

  it('single-flight: a poller no-ops while another holds the lease (concurrent pollers)', async () => {
    await t.db.adminQuery(`UPDATE email_poll_state SET claimed_until = now() + interval '30 seconds' WHERE id=true`);
    const rec = new FakeReceiver([[sum('rc-locked', '<locked@m>')]]);
    const r = await email.pollOnce(rec);
    expect(r.skipped).toBe(true);
    expect(rec.listCalls).toBe(0); // did not scan while another poller holds the lease
    expect(await eventCount('rc-locked')).toBe(0);
    await t.db.adminQuery(`UPDATE email_poll_state SET claimed_until = NULL WHERE id=true`); // release for later tests
  });
});

describe('006/D21.1 — polled replies run the existing correlation gates', () => {
  it('invalid token, unrelated email, and wrong-shop token all create no work', async () => {
    const shopA = await createShop('rb-poll-b');
    const shopB = await createShop('rb-poll-c');
    const reqB = await awaitingRequest(shopB);
    const forgedForA = mintReplyToken(KEY, shopA, reqB); // signed for shopA but names shopB's request
    const rec = new FakeReceiver(
      [[sum('rc-bad', '<bad@m>'), sum('rc-unrel', '<unrel@m>'), sum('rc-xshop', '<xshop@m>')]],
      {
        'rc-bad': { messageId: '<bad@m>', to: ['reply+not.a.valid.token@rb.resend.app'], from: 'x@y.com', text: 'hi' },
        'rc-unrel': { messageId: '<unrel@m>', to: ['sales@rb.resend.app'], from: 'x@y.com', text: 'unrelated' },
        'rc-xshop': { messageId: '<xshop@m>', to: [`reply+${forgedForA}@rb.resend.app`], from: 'x@y.com', text: 'inject' },
      },
    );
    await email.pollOnce(rec);
    await email.processPendingEvents(rec);
    const ev = await t.db.adminQuery<{ status: string }>(`SELECT status FROM email_events WHERE resend_email_id IN ('rc-bad','rc-unrel','rc-xshop')`);
    expect(ev.rows.every((r) => r.status === 'ignored')).toBe(true);
    const fuB = await t.db.adminQuery<{ reply_content: string | null }>(`SELECT reply_content FROM follow_ups WHERE request_id=$1`, [reqB]);
    expect(fuB.rows[0]!.reply_content).toBeNull(); // shop B untouched (no cross-tenant injection)
  });

  it('duplicate Message-ID across two polled emails resumes once; one-round guard holds after resolution', async () => {
    const shop = await createShop('rb-poll-d');
    const reqId = await awaitingRequest(shop);
    const token = mintReplyToken(KEY, shop, reqId);
    // Two distinct receiving ids carrying the SAME RFC Message-ID.
    const rec = new FakeReceiver(
      [[sum('rc-d1', '<same-msg@m>'), sum('rc-d2', '<same-msg@m>')]],
      {
        'rc-d1': { messageId: '<same-msg@m>', to: [`reply+${token}@rb.resend.app`], from: 'rider@example.com', text: 'use the ceramic set' },
        'rc-d2': { messageId: '<same-msg@m>', to: [`reply+${token}@rb.resend.app`], from: 'rider@example.com', text: 'use the ceramic set' },
      },
    );
    const baseJobs = await jobCount(reqId);
    await email.pollOnce(rec);
    await email.processPendingEvents(rec);
    expect(await jobCount(reqId)).toBe(baseJobs + 1); // Message-ID dedup → single resumption despite two emails

    // One round: once the request is no longer awaiting_customer, a later distinct reply is ignored.
    await t.db.adminQuery(`UPDATE requests SET state='extracted' WHERE id=$1`, [reqId]);
    const later = new FakeReceiver([[sum('rc-late', '<late@m>')]], { 'rc-late': { messageId: '<late@m>', to: [`reply+${token}@rb.resend.app`], from: 'rider@example.com', text: 'actually, change it' } });
    await email.pollOnce(later);
    await email.processPendingEvents(later);
    const ev = await t.db.adminQuery<{ status: string; detail: string }>(`SELECT status, detail FROM email_events WHERE resend_email_id='rc-late'`);
    expect(ev.rows[0]!.detail).toBe('ignored_not_awaiting');
  });
});
