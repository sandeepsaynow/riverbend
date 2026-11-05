import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { recoverHeldBudget } from '../../src/worker/sweeper.js';

// 007/D25 — a request parked at held_budget completed its job cleanly, so pg-boss never retries it.
// recoverHeldBudget re-drives it (once past a cooldown) by inserting a fresh outbox row — the sanctioned
// new-work path — so the pipeline re-checks the budget and proceeds or re-parks. No model spend here.
let t: TestDb;
let intake: IntakeService;
let n = 0;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
/** A request forced to held_budget with a chosen age, its original intake outbox row removed to isolate. */
async function heldRequest(shopId: string, ageSeconds: number): Promise<string> {
  const sub = await intake.submit({ shopId, source: 'web', submissionId: `hb-${++n}`, content: 'brakes feel soft', customerEmail: 'r@x.test' });
  await t.db.adminQuery(`DELETE FROM job_outbox WHERE request_id=$1`, [sub.requestId]);
  await t.db.adminQuery(`UPDATE requests SET state='held_budget', updated_at = now() - ($2 || ' seconds')::interval WHERE id=$1`, [sub.requestId, String(ageSeconds)]);
  return sub.requestId;
}
async function pendingOutbox(requestId: string): Promise<number> {
  const r = await t.db.adminQuery<{ c: string }>(`SELECT count(*)::text AS c FROM job_outbox WHERE request_id=$1 AND status='pending'`, [requestId]);
  return Number(r.rows[0]!.c);
}

beforeAll(async () => { t = await startTestDb(); intake = new IntakeService(t.db); }, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('held_budget automatic recovery', () => {
  it('re-drives a held_budget request past the cooldown via a fresh outbox row', async () => {
    const shop = await createShop('rb-hb-a');
    const req = await heldRequest(shop, 600);
    expect(await recoverHeldBudget(t.db, 300)).toBeGreaterThanOrEqual(1);
    expect(await pendingOutbox(req)).toBe(1); // one new outbox row → the relay will re-enqueue it
  });

  it('does NOT re-drive a held request still within the cooldown', async () => {
    const shop = await createShop('rb-hb-b');
    const req = await heldRequest(shop, 10);
    await recoverHeldBudget(t.db, 300);
    expect(await pendingOutbox(req)).toBe(0);
  });

  it('never re-drives a request that is not held_budget (e.g. already extracted)', async () => {
    const shop = await createShop('rb-hb-c');
    const sub = await intake.submit({ shopId: shop, source: 'web', submissionId: `x-${++n}`, content: 'brakes', customerEmail: 'r@x.test' });
    await t.db.adminQuery(`DELETE FROM job_outbox WHERE request_id=$1`, [sub.requestId]);
    await t.db.adminQuery(`UPDATE requests SET state='extracted', updated_at = now() - interval '1 hour' WHERE id=$1`, [sub.requestId]);
    await recoverHeldBudget(t.db, 300);
    expect(await pendingOutbox(sub.requestId)).toBe(0);
  });

  it('is a no-op when disabled (minAgeSeconds = 0)', async () => {
    expect(await recoverHeldBudget(t.db, 0)).toBe(0);
  });
});
