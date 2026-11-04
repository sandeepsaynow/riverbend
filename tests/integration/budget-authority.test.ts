import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { PipelineService } from '../../src/modules/pipeline/index.js';
import { LiteLlmProvisioner, type LiteLlmAdminApi } from '../../src/modules/budget/litellm-admin.js';
import { BudgetExceededError, type ExtractCtx, type ExtractionInput, type LlmGateway } from '../../src/platform/llm/index.js';

const PERIOD = '2026-09';
const FORM = { kind: 'repair', bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }], urgency: 'normal', dateWords: null, questionDraft: null };

/** Fake admin: records provisioning calls, returns deterministic team/key per alias. */
class FakeAdmin implements LiteLlmAdminApi {
  teams = 0; keys = 0;
  async createTeam(alias: string): Promise<string> { this.teams++; return `team-${alias}`; }
  async createVirtualKey(teamId: string): Promise<string> { this.keys++; return `sk-vkey-${teamId}-${this.keys}`; }
}

/** Fake gateway that records the per-call key it was handed (proves the shop's virtual key is used). */
class KeyRecordingGateway implements LlmGateway {
  readonly name = 'key-rec';
  lastCostMicros: number | undefined;
  lastUsage: { model: string; promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
  seenKeys: string[] = [];
  async extract(_input: ExtractionInput, ctx?: ExtractCtx): Promise<unknown> {
    this.seenKeys.push(ctx?.apiKey ?? '(none)');
    this.lastCostMicros = 137;
    this.lastUsage = { model: 'mock', promptTokens: 30, completionTokens: 20, totalTokens: 50 };
    return FORM;
  }
}

let t: TestDb;
let intake: IntakeService;
let n = 0;
async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
async function req(shopId: string): Promise<string> {
  return (await intake.submit({ shopId, source: 'api', submissionId: `ba-${++n}`, content: 'tune please' })).requestId;
}
const state = (id: string) => t.db.adminQuery<{ state: string }>(`SELECT state FROM requests WHERE id=$1`, [id]).then((r) => r.rows[0]!.state);

beforeAll(async () => {
  t = await startTestDb();
  intake = new IntakeService(t.db);
  await new CatalogService(t.db).seedFromFile(resolve(process.cwd(), 'catalog/catalog.json'));
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('budget authority 2.0.0 — provisioning + per-shop keys', () => {
  it('provisions a team+key once per shop, reuses after, and isolates tenants', async () => {
    const admin = new FakeAdmin();
    const prov = new LiteLlmProvisioner(t.db, admin, { budgetUsd: 5, budgetDuration: '30d' });
    const a = await createShop('rb-ba-a');
    const b = await createShop('rb-ba-b');
    const ka1 = await prov.ensureVirtualKey(a);
    const ka2 = await prov.ensureVirtualKey(a); // reuse → no new provisioning
    const kb = await prov.ensureVirtualKey(b);
    expect(ka1).toBe(ka2);
    expect(ka1).not.toBe(kb);
    expect(admin.teams).toBe(2); // one per shop, not per call
    // Each shop sees only its own identity (RLS).
    const bToA = await t.db.withTenant(b, (c) => c.query(`SELECT virtual_key FROM shop_llm_identity WHERE shop_id=$1`, [a]));
    expect(bToA.rowCount).toBe(0);
  });
});

describe('budget authority 2.0.0 — pipeline in litellm mode', () => {
  it('uses the shop virtual key (never the master key), records proxy cost, no reservation ledger', async () => {
    const admin = new FakeAdmin();
    const prov = new LiteLlmProvisioner(t.db, admin, { budgetUsd: 5, budgetDuration: '30d' });
    const shop = await createShop('rb-ba-lit');
    const gw = new KeyRecordingGateway();
    const pipe = new PipelineService(t.db, gw, {
      defaultBudgetMicros: 5_000_000, estimateMicros: 2_000, period: PERIOD,
      budgetAuthority: 'litellm', resolveKey: (s) => prov.ensureVirtualKey(s),
    });
    const id = await req(shop);
    await pipe.run({ requestId: id, shopId: shop });
    expect(await state(id)).toBe('extracted');
    expect(gw.seenKeys[0]).toMatch(/^sk-vkey-team-shop:/); // the shop's virtual key, not a master key
    // Accounting row: real proxy cost, proxy_calculated, no shop_budgets reservation created.
    const call = await t.db.adminQuery<{ cost_micros: string; cost_source: string; model: string }>(
      `SELECT cost_micros, cost_source, model FROM llm_calls WHERE request_id=$1`, [id]);
    expect(Number(call.rows[0]!.cost_micros)).toBe(137);
    expect(call.rows[0]!.cost_source).toBe('proxy_calculated');
    const budgets = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM shop_budgets WHERE shop_id=$1`, [shop]);
    expect(Number(budgets.rows[0]!.n)).toBe(0); // litellm mode does NOT create a Riverbend reservation ledger
  });

  it('a proxy budget rejection → held_budget (fail-closed); a replay does not double-count', async () => {
    const admin = new FakeAdmin();
    const prov = new LiteLlmProvisioner(t.db, admin, { budgetUsd: 5, budgetDuration: '30d' });
    const shop = await createShop('rb-ba-reject');
    const rejecting: LlmGateway = { name: 'reject', async extract() { throw new BudgetExceededError('422'); } };
    const pipe = new PipelineService(t.db, rejecting, { defaultBudgetMicros: 5_000_000, estimateMicros: 2_000, period: PERIOD, budgetAuthority: 'litellm', resolveKey: (s) => prov.ensureVirtualKey(s) });
    const id = await req(shop);
    await pipe.run({ requestId: id, shopId: shop });
    expect(await state(id)).toBe('held_budget');

    // Idempotent accounting: a successful call recorded once stays once on replay.
    const shop2 = await createShop('rb-ba-replay');
    const gw = new KeyRecordingGateway();
    const pipe2 = new PipelineService(t.db, gw, { defaultBudgetMicros: 5_000_000, estimateMicros: 2_000, period: PERIOD, budgetAuthority: 'litellm', resolveKey: (s) => prov.ensureVirtualKey(s) });
    const id2 = await req(shop2);
    await pipe2.run({ requestId: id2, shopId: shop2 });
    await t.db.adminQuery(`UPDATE requests SET state='awaiting_pipeline' WHERE id=$1`, [id2]); // force a redelivery
    await pipe2.run({ requestId: id2, shopId: shop2 });
    const calls = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM llm_calls WHERE request_id=$1 AND step='extract' AND attempt=1`, [id2]);
    expect(Number(calls.rows[0]!.n)).toBe(1); // no double-count
  });

  it('budget infrastructure unavailable → fail closed (held_budget), no model call', async () => {
    const shop = await createShop('rb-ba-infra');
    const gw = new KeyRecordingGateway();
    const pipe = new PipelineService(t.db, gw, {
      defaultBudgetMicros: 5_000_000, estimateMicros: 2_000, period: PERIOD,
      budgetAuthority: 'litellm', resolveKey: async () => { throw new Error('proxy admin down'); },
    });
    const id = await req(shop);
    await pipe.run({ requestId: id, shopId: shop });
    expect(await state(id)).toBe('held_budget');
    expect(gw.seenKeys).toHaveLength(0); // never reached the model
    const err = await t.db.adminQuery<{ last_error: string }>(`SELECT last_error FROM requests WHERE id=$1`, [id]);
    expect(err.rows[0]!.last_error).toBe('budget_infra_unavailable');
  });
});
