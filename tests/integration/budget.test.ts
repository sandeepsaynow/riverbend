import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { BudgetService } from '../../src/modules/budget/index.js';

const PERIOD = '2026-09';
const EST = 1000; // micros per call
let t: TestDb;
let budget: BudgetService;
let intake: IntakeService;
let shopId: string;
let requestId: string;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(
    `INSERT INTO shops (slug, time_zone, display_name) VALUES ($1, 'America/Chicago', $1) RETURNING id`,
    [slug],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  t = await startTestDb();
  budget = new BudgetService(t.db);
  intake = new IntakeService(t.db);
  shopId = await createShop('rb-budget');
  const sub = await intake.submit({ shopId, source: 'api', submissionId: 'b-1', content: 'tune' });
  requestId = sub.requestId;
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

describe('budget reserve-then-settle (I4)', () => {
  it('N concurrent reservations against a cap fitting K succeed exactly K times (SC-003)', async () => {
    await budget.ensureBudget(shopId, PERIOD, 5 * EST); // cap fits exactly 5
    const reserves = Array.from({ length: 20 }, (_, i) =>
      budget.reserve({ shopId, requestId, period: PERIOD, step: 'extract', attempt: i + 1, estimateMicros: EST }),
    );
    const results = await Promise.all(reserves);
    const granted = results.filter((r) => r.ok && !r.reused);
    expect(granted).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(15);
    const usage = await budget.usage(shopId, PERIOD);
    expect(usage?.reservedMicros).toBe(5 * EST);
    expect(usage?.spentMicros).toBe(0);
    expect((usage!.spentMicros + usage!.reservedMicros)).toBeLessThanOrEqual(usage!.capMicros);
  });

  it('a replayed reservation reuses the receipt and does not charge again (SC-004)', async () => {
    const replay = await budget.reserve({ shopId, requestId, period: PERIOD, step: 'extract', attempt: 1, estimateMicros: EST });
    expect(replay.reused).toBe(true);
    const usage = await budget.usage(shopId, PERIOD);
    expect(usage?.reservedMicros).toBe(5 * EST); // unchanged by the replay
  });

  it('settling a call moves reserved → spent at the real cost', async () => {
    await budget.ensureBudget(shopId, PERIOD, 10 * EST); // raise the cap → headroom (resume path)
    const granted = await budget.reserve({ shopId, requestId, period: PERIOD, step: 'settle-demo', attempt: 1, estimateMicros: EST });
    expect(granted.ok).toBe(true);
    const before = await budget.usage(shopId, PERIOD);
    await budget.settle(shopId, granted.callId!, 800);
    const after = await budget.usage(shopId, PERIOD);
    expect(after!.reservedMicros).toBe(before!.reservedMicros - EST);
    expect(after!.spentMicros).toBe(before!.spentMicros + 800);
    // idempotent settle
    await budget.settle(shopId, granted.callId!, 800);
    const again = await budget.usage(shopId, PERIOD);
    expect(again!.spentMicros).toBe(after!.spentMicros);
  });

  it('reaps an abandoned reservation by settling it at the estimate (no leak, FR-008)', async () => {
    const other = await createShop('rb-budget-2');
    const sub = await intake.submit({ shopId: other, source: 'api', submissionId: 'r-1', content: 'tune' });
    await budget.ensureBudget(other, PERIOD, 10 * EST);
    await budget.reserve({ shopId: other, requestId: sub.requestId, period: PERIOD, step: 'extract', attempt: 1, estimateMicros: EST });
    const reaped = await budget.reapOlderThan(other, 0);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const usage = await budget.usage(other, PERIOD);
    expect(usage?.reservedMicros).toBe(0);
    expect(usage?.spentMicros).toBe(EST);
  });

  it('isolation: a shop sees only its own budget rows (RLS)', async () => {
    const leak = await budget.usage(shopId, PERIOD);
    expect(leak).not.toBeNull(); // own row visible
    // querying another shop's budget as this tenant returns null (RLS filters it)
    const crossTenant = await t.db.withTenant(shopId, (c) =>
      c.query(`SELECT count(*)::int AS n FROM shop_budgets WHERE shop_id <> $1`, [shopId]),
    );
    expect(crossTenant.rows[0].n).toBe(0);
  });
});
