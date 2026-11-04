import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { PipelineService } from '../../src/modules/pipeline/index.js';
import { OrdersService } from '../../src/modules/orders/index.js';
import type { ExtractCtx, ExtractionInput, LlmGateway } from '../../src/platform/llm/index.js';

type Form = { kind: string; bikes: Array<{ bikeNumber: number; issues: string[]; serviceCodes: string[]; wheels?: Array<'front' | 'rear'> }>; urgency: 'normal' | 'urgent'; dateWords: string | null; questionDraft: string | null };

class ConfigurableGateway implements LlmGateway {
  readonly name = 'cfg';
  calls = 0;
  constructor(private readonly form: Form) {}
  async extract(_i: ExtractionInput, _c?: ExtractCtx): Promise<unknown> { this.calls += 1; return this.form; }
}

const PERIOD = '2026-09';
let t: TestDb;
let intake: IntakeService;
let orders: OrdersService;
let n = 0;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
async function submit(shopId: string, content: string): Promise<string> {
  return (await intake.submit({ shopId, source: 'api', submissionId: `g-${++n}`, content })).requestId;
}
const state = (id: string) => t.db.adminQuery<{ state: string; last_error: string | null }>(`SELECT state, last_error FROM requests WHERE id=$1`, [id]).then((r) => r.rows[0]!);
async function items(id: string) {
  const r = await t.db.adminQuery<{ code: string; quantity: number; line_total_cents: number }>(
    `SELECT woi.code, woi.quantity, woi.line_total_cents FROM work_order_items woi JOIN work_orders wo ON wo.id=woi.order_id WHERE wo.request_id=$1`, [id]);
  return r.rows;
}
const orderCount = (id: string) => t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM work_orders WHERE request_id=$1`, [id]).then((r) => Number(r.rows[0]!.n));

let downtown: string;
beforeAll(async () => {
  t = await startTestDb();
  intake = new IntakeService(t.db);
  orders = new OrdersService(t.db);
  await new CatalogService(t.db).seedFromFile(resolve(process.cwd(), 'catalog/catalog.json'));
  downtown = await createShop('rb-downtown');
  await createShop('rb-lakeshore');
  await createShop('rb-northside');
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

function pipe(form: Form): { p: PipelineService; gw: ConfigurableGateway } {
  const gw = new ConfigurableGateway(form);
  return { p: new PipelineService(t.db, gw, { defaultBudgetMicros: 5_000_000, estimateMicros: 2_000, period: PERIOD }), gw };
}

describe('correctness guards (end-to-end)', () => {
  it('m-1025: broad delegation → GENERAL_INSPECT only, flagged (no invented repair list)', async () => {
    const id = await submit(downtown, 'My bike has been sitting for years. Brakes, tires, chain all look rough. Whatever it needs.');
    const { p } = pipe({ kind: 'repair', bikes: [{ bikeNumber: 1, issues: ['brakes', 'chain', 'tires'], serviceCodes: ['BRAKE_ADJUST', 'CHAIN_REPLACE', 'TIRE_REPLACE'], wheels: ['front', 'rear'] }], urgency: 'normal', dateWords: null, questionDraft: null });
    await p.run({ requestId: id, shopId: downtown });
    await orders.createFromExtraction(downtown, id);
    expect((await state(id)).state).toBe('ordered');
    const its = await items(id);
    expect(its.map((i) => i.code)).toEqual(['GENERAL_INSPECT']); // invented list dropped
    expect(its[0]!.line_total_cents).toBe(2500);
    const ex = await t.db.adminQuery<{ flagged: boolean }>(`SELECT flagged FROM extractions WHERE request_id=$1`, [id]);
    expect(ex.rows[0]!.flagged).toBe(true);
  });

  it('m-1009: message addressing another shop → needs_review, no model call, no order', async () => {
    const id = await submit(downtown, 'Hi Lakeshore team! Following up — can you also tune my road bike? Sunday works.');
    const { p, gw } = pipe({ kind: 'repair', bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }], urgency: 'normal', dateWords: null, questionDraft: null });
    await p.run({ requestId: id, shopId: downtown });
    await orders.createFromExtraction(downtown, id);
    const s = await state(id);
    expect(s.state).toBe('needs_review');
    expect(s.last_error).toBe('wrong_shop_suspected');
    expect(gw.calls).toBe(0); // short-circuited before any model call
    expect(await orderCount(id)).toBe(0);
  });

  it('m-1032: single-bike message but model returns two → trimmed to one order', async () => {
    const id = await submit(downtown, 'Basic tune-up on my cargo bike before winter. Any weekday.');
    const twoBikes: Form = { kind: 'repair', bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }, { bikeNumber: 2, issues: [], serviceCodes: ['TUNE_BASIC'] }], urgency: 'normal', dateWords: null, questionDraft: null };
    const { p } = pipe(twoBikes);
    await p.run({ requestId: id, shopId: downtown });
    await orders.createFromExtraction(downtown, id);
    expect(await orderCount(id)).toBe(1); // extra invented bike dropped
    expect((await items(id)).reduce((s, i) => s + i.line_total_cents, 0)).toBe(6500);
  });

  it('m-1040: explicit two bikes → both kept (guard does not over-trim)', async () => {
    const id = await submit(downtown, "Basic tune-up for my daughter's bike and mine, two bikes. Saturday.");
    const twoBikes: Form = { kind: 'repair', bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }, { bikeNumber: 2, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }], urgency: 'normal', dateWords: null, questionDraft: null };
    const { p } = pipe(twoBikes);
    await p.run({ requestId: id, shopId: downtown });
    await orders.createFromExtraction(downtown, id);
    expect(await orderCount(id)).toBe(2);
  });
});
