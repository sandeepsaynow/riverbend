import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { BudgetService } from '../../src/modules/budget/index.js';
import { PipelineService } from '../../src/modules/pipeline/index.js';
import { FakeGateway } from '../../src/platform/llm/fake-gateway.js';
import { BudgetExceededError, type ExtractionInput, type LlmGateway } from '../../src/platform/llm/index.js';
import { ResilientGateway } from '../../src/platform/llm/resilient-gateway.js';

const TUNE_FORM = { kind: 'repair', bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }], urgency: 'normal', dateWords: null, questionDraft: null };

/** Reports a proxy-calculated cost (FR-007 real-cost capture), zero network. */
class CostGateway implements LlmGateway {
  readonly name = 'cost-fake';
  lastCostMicros: number | undefined;
  constructor(private readonly costMicros: number) {}
  async extract(_input: ExtractionInput): Promise<unknown> {
    this.lastCostMicros = this.costMicros;
    return TUNE_FORM;
  }
}
/** Simulates the budget authority denying admission before the provider (I4 fail-closed), zero network. */
class RejectGateway implements LlmGateway {
  readonly name = 'reject-fake';
  async extract(_input: ExtractionInput): Promise<unknown> {
    throw new BudgetExceededError('proxy denied admission (test)');
  }
}

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

  it('price inquiry → answered; D32: a message naming another shop is NOT re-routed (origin retained)', async () => {
    const price = await newRequest('how much for a full overhaul?');
    await pipeline.run({ requestId: price, shopId });
    expect(await state(price)).toBe('answered');
    // D32: the "Lakeshore" mention is ignored for routing (origin shop is authoritative). "my bike squeaks"
    // is a symptom with no specific service → ask for repair details (awaiting_customer), NOT needs_review.
    const wrong = await newRequest('Hi Lakeshore team! my bike squeaks');
    await pipeline.run({ requestId: wrong, shopId });
    expect(await state(wrong)).toBe('awaiting_customer');
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

describe('budget migration (1.2.0): real-cost capture + fail-closed proxy rejection', () => {
  it('settles the ledger at the proxy-calculated real cost, not the estimate (FR-007)', async () => {
    const shop = await createShop('rb-realcost');
    await budget.ensureBudget(shop, PERIOD, 1_000_000);
    const pipe = new PipelineService(t.db, new CostGateway(137), { defaultBudgetMicros: 1_000_000, estimateMicros: 2_000, period: PERIOD });
    const sub = await intake.submit({ shopId: shop, source: 'api', submissionId: 'rc-1', content: 'tune please' });
    await pipe.run({ requestId: sub.requestId, shopId: shop });
    expect(await state(sub.requestId)).toBe('extracted');
    const call = await t.db.adminQuery<{ cost_micros: string; status: string }>(
      `SELECT cost_micros, status FROM llm_calls WHERE request_id=$1 AND step='extract'`, [sub.requestId]);
    expect(call.rows[0]!.status).toBe('settled');
    expect(Number(call.rows[0]!.cost_micros)).toBe(137); // real proxy cost, not the 2000 estimate
    const usage = await budget.usage(shop, PERIOD);
    expect(usage!.spentMicros).toBe(137);
    expect(usage!.reservedMicros).toBe(0);
  });

  it('a proxy budget rejection parks held_budget without retry (I4 fail-closed)', async () => {
    const shop = await createShop('rb-failclosed');
    await budget.ensureBudget(shop, PERIOD, 1_000_000); // cap has room; the PROXY is what refuses
    const pipe = new PipelineService(t.db, new RejectGateway(), { defaultBudgetMicros: 1_000_000, estimateMicros: 2_000, period: PERIOD });
    const sub = await intake.submit({ shopId: shop, source: 'api', submissionId: 'fc-1', content: 'tune please' });
    await pipe.run({ requestId: sub.requestId, shopId: shop });
    expect(await state(sub.requestId)).toBe('held_budget');
    // The attempt was recorded then settled to 0 (no charge), and not retried a second time.
    const calls = await t.db.adminQuery<{ cost_micros: string; status: string }>(
      `SELECT cost_micros, status FROM llm_calls WHERE request_id=$1 AND step='extract'`, [sub.requestId]);
    expect(calls.rows).toHaveLength(1); // single attempt, no escalation retry
    expect(Number(calls.rows[0]!.cost_micros)).toBe(0);
    const usage = await budget.usage(shop, PERIOD);
    expect(usage!.spentMicros).toBe(0); // fail-closed: nothing charged
  });

  it('007: the AI-paused switch parks held_budget with no model call', async () => {
    const shop = await createShop('rb-paused');
    await budget.ensureBudget(shop, PERIOD, 1_000_000);
    const paused = new ResilientGateway(new FakeGateway(), { failureThreshold: 5, cooldownMs: 1000, maxConcurrentPerShop: 4, isPaused: () => true });
    const pipe = new PipelineService(t.db, paused, { defaultBudgetMicros: 1_000_000, estimateMicros: 2_000, period: PERIOD });
    const sub = await intake.submit({ shopId: shop, source: 'api', submissionId: 'ap-1', content: 'tune please' });
    await pipe.run({ requestId: sub.requestId, shopId: shop });
    expect(await state(sub.requestId)).toBe('held_budget');
    const usage = await budget.usage(shop, PERIOD);
    expect(usage!.spentMicros).toBe(0); // paused: nothing charged
  });
});
