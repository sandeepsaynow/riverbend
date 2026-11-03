import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { BudgetService } from '../../src/modules/budget/index.js';
import { PipelineService } from '../../src/modules/pipeline/index.js';
import { FakeGateway } from '../../src/platform/llm/fake-gateway.js';

const PERIOD = '2026-09';
let t: TestDb;
let intake: IntakeService;
let pipeline: PipelineService;
let budget: BudgetService;
let shopId: string;
let n = 0;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(
    `INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`,
    [slug],
  );
  return r.rows[0]!.id;
}
async function newRequest(content: string): Promise<string> {
  const sub = await intake.submit({ shopId, source: 'api', submissionId: `p-${++n}`, content });
  return sub.requestId;
}
function state(requestId: string): Promise<string> {
  return t.db.adminQuery<{ state: string }>(`SELECT state FROM requests WHERE id=$1`, [requestId]).then((r) => r.rows[0]!.state);
}

beforeAll(async () => {
  t = await startTestDb();
  intake = new IntakeService(t.db);
  budget = new BudgetService(t.db);
  pipeline = new PipelineService(t.db, new FakeGateway(), { defaultBudgetMicros: 1_000_000, estimateMicros: 2_000, period: PERIOD });
  await new CatalogService(t.db).seedFromFile(resolve(process.cwd(), 'catalog/catalog.json'));
  shopId = await createShop('rb-pipe');
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

describe('AI pipeline (003) against the fake gateway', () => {
  it('repair with a known service → extracted, with a recorded + settled cost', async () => {
    const id = await newRequest('my road bike needs a tune');
    await pipeline.run({ requestId: id, shopId });
    expect(await state(id)).toBe('extracted');
    const ex = await t.db.adminQuery<{ bikes: unknown }>(`SELECT bikes FROM extractions WHERE request_id=$1`, [id]);
    expect(JSON.stringify(ex.rows[0]!.bikes)).toContain('TUNE_BASIC');
    const usage = await budget.usage(shopId, PERIOD);
    expect(usage!.spentMicros).toBeGreaterThan(0);
  });

  it('invalid model output → one escalation retry, then needs_review; nothing usable persisted (I3)', async () => {
    const id = await newRequest('__BAD_CODE__ weird');
    await pipeline.run({ requestId: id, shopId });
    expect(await state(id)).toBe('needs_review');
    const calls = await t.db.adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM llm_calls WHERE request_id=$1 AND step='extract'`,
      [id],
    );
    expect(Number(calls.rows[0]!.n)).toBe(2); // attempt 1 + one escalation
    const ex = await t.db.adminQuery(`SELECT 1 FROM extractions WHERE request_id=$1`, [id]);
    expect(ex.rowCount).toBe(0); // invalid output never persisted as a usable extraction
  });

  it('price inquiry → answered; wrong shop → needs_review (never auto-moved)', async () => {
    const price = await newRequest('how much for a full overhaul?');
    await pipeline.run({ requestId: price, shopId });
    expect(await state(price)).toBe('answered');
    const wrong = await newRequest('Hi Lakeshore team! my bike squeaks');
    await pipeline.run({ requestId: wrong, shopId });
    expect(await state(wrong)).toBe('needs_review');
  });

  it('ambiguous → exactly one follow-up (I6); a second follow-up is refused by the DB', async () => {
    const id = await newRequest('my brakes feel off');
    await pipeline.run({ requestId: id, shopId });
    expect(await state(id)).toBe('awaiting_customer');
    const fu = await t.db.adminQuery<{ question: string }>(`SELECT question FROM follow_ups WHERE request_id=$1`, [id]);
    expect(fu.rows).toHaveLength(1);
    await expect(
      t.db.adminQuery(`INSERT INTO follow_ups (shop_id, request_id, question) VALUES ($1,$2,'second?')`, [shopId, id]),
    ).rejects.toBeTruthy(); // UNIQUE(request_id) enforces ≤ 1 (I6)
  });

  it('reply resolves the request → extracted with the right service (resumption)', async () => {
    const id = await newRequest('my brakes feel off');
    await pipeline.run({ requestId: id, shopId });
    expect(await state(id)).toBe('awaiting_customer');
    await pipeline.applyReply(shopId, id, 'please replace the brake pads and bleed them, front and rear');
    await pipeline.run({ requestId: id, shopId }, { isReply: true });
    expect(await state(id)).toBe('extracted');
    const ex = await t.db.adminQuery<{ bikes: unknown; flagged: boolean }>(`SELECT bikes, flagged FROM extractions WHERE request_id=$1`, [id]);
    expect(ex.rows[0]!.flagged).toBe(false);
    expect(JSON.stringify(ex.rows[0]!.bikes)).toContain('BRAKE_PADS');
  });

  it('reply still ambiguous but a symptom remains → flagged general inspection', async () => {
    const id = await newRequest('my brakes feel off');
    await pipeline.run({ requestId: id, shopId });
    await pipeline.applyReply(shopId, id, 'still just the brakes, not sure what service');
    await pipeline.run({ requestId: id, shopId }, { isReply: true });
    expect(await state(id)).toBe('extracted');
    const ex = await t.db.adminQuery<{ bikes: unknown; flagged: boolean }>(`SELECT bikes, flagged FROM extractions WHERE request_id=$1`, [id]);
    expect(ex.rows[0]!.flagged).toBe(true);
    expect(JSON.stringify(ex.rows[0]!.bikes)).toContain('GENERAL_INSPECT');
  });

  it('at the cap → held_budget, no model call (D7)', async () => {
    const other = await createShop('rb-pipe-broke');
    await budget.ensureBudget(other, PERIOD, 0); // cap zero
    const sub = await intake.submit({ shopId: other, source: 'api', submissionId: 'hb-1', content: 'needs a tune' });
    await pipeline.run({ requestId: sub.requestId, shopId: other });
    expect(await state(sub.requestId)).toBe('held_budget');
    const calls = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM llm_calls WHERE request_id=$1`, [sub.requestId]);
    expect(Number(calls.rows[0]!.n)).toBe(0); // nothing reserved/charged at the cap
  });
});
