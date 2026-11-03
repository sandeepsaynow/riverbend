import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { OrdersService } from '../../src/modules/orders/index.js';

let t: TestDb;
let intake: IntakeService;
let orders: OrdersService;
let shopId: string;
let shopB: string;
let n = 0;

async function createShop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(
    `INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug],
  );
  return r.rows[0]!.id;
}
/** Create a request already in `extracted` with a known extraction (bypasses the AI; deterministic pricing). */
async function makeExtracted(shop: string, bikes: unknown): Promise<string> {
  const sub = await intake.submit({ shopId: shop, source: 'api', submissionId: `o-${++n}`, content: 'order please' });
  await t.db.adminQuery(`UPDATE requests SET state='extracted' WHERE id=$1`, [sub.requestId]);
  await t.db.adminQuery(
    `INSERT INTO extractions (shop_id, request_id, kind, bikes, urgency) VALUES ($1,$2,'repair',$3,'normal')`,
    [shop, sub.requestId, JSON.stringify(bikes)],
  );
  return sub.requestId;
}
function state(id: string): Promise<string> {
  return t.db.adminQuery<{ state: string }>(`SELECT state FROM requests WHERE id=$1`, [id]).then((r) => r.rows[0]!.state);
}

beforeAll(async () => {
  t = await startTestDb();
  intake = new IntakeService(t.db);
  orders = new OrdersService(t.db);
  await new CatalogService(t.db).seedFromFile(resolve(process.cwd(), 'catalog/catalog.json'));
  shopId = await createShop('rb-orders');
  shopB = await createShop('rb-orders-b');
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

describe('work orders & pricing (004, I2/I5)', () => {
  it('m-1029: per-wheel services ×2 wheels → USD 150, computed in code', async () => {
    const id = await makeExtracted(shopId, [
      { bikeNumber: 1, issues: ['brakes'], serviceCodes: ['BRAKE_PADS', 'BRAKE_BLEED'], wheels: ['front', 'rear'] },
    ]);
    await orders.createFromExtraction(shopId, id);
    expect(await state(id)).toBe('ordered');
    const { orders: list } = await orders.listOpenOrders(shopId);
    const mine = list.find((o) => o.request_id === id)!;
    expect(mine.order_total_cents).toBe(15_000); // (3500+4000) × 2
  });

  it('m-1040: two bikes → two orders, USD 65 each (USD 130)', async () => {
    const id = await makeExtracted(shopId, [
      { bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] },
      { bikeNumber: 2, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] },
    ]);
    await orders.createFromExtraction(shopId, id);
    const { orders: list } = await orders.listOpenOrders(shopId);
    const two = list.filter((o) => o.request_id === id);
    expect(two).toHaveLength(2);
    expect(two.every((o) => o.order_total_cents === 6_500)).toBe(true);
  });

  it('idempotent: re-running creates no duplicate order per bike (I2)', async () => {
    const id = await makeExtracted(shopId, [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }]);
    await orders.createFromExtraction(shopId, id);
    await orders.createFromExtraction(shopId, id); // replay
    const count = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM work_orders WHERE request_id=$1`, [id]);
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('a later catalog price change leaves existing order items unchanged (snapshot)', async () => {
    const id = await makeExtracted(shopId, [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }]);
    await orders.createFromExtraction(shopId, id);
    await t.db.adminQuery(`UPDATE catalog_service SET price_cents = 9999 WHERE code='TUNE_BASIC'`);
    const { orders: list } = await orders.listOpenOrders(shopId);
    const mine = list.find((o) => o.request_id === id)!;
    expect(mine.items[0]!.unit_price_cents).toBe(6_500); // snapshotted, not 9999
    await t.db.adminQuery(`UPDATE catalog_service SET price_cents = 6500 WHERE code='TUNE_BASIC'`); // restore
  });

  it('requires_inspection item is included at the listed price and flagged', async () => {
    const id = await makeExtracted(shopId, [{ bikeNumber: 1, issues: ['e-bike'], serviceCodes: ['EBIKE_DIAG'] }]);
    await orders.createFromExtraction(shopId, id);
    const { orders: list } = await orders.listOpenOrders(shopId);
    const item = list.find((o) => o.request_id === id)!.items[0]!;
    expect(item.requires_inspection).toBe(true);
    expect(item.unit_price_cents).toBe(6_000); // EBIKE_DIAG = $60.00 (authoritative catalog)
  });
});

describe('staff reads (004) — tenant-scoped', () => {
  it('open-orders and needs-attention never cross tenants (RLS)', async () => {
    const id = await makeExtracted(shopId, [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }]);
    await orders.createFromExtraction(shopId, id);
    const a = await orders.listOpenOrders(shopId);
    const b = await orders.listOpenOrders(shopB);
    expect(a.orders.length).toBeGreaterThan(0);
    expect(b.orders).toHaveLength(0); // shop B sees none of shop A's orders

    await t.db.adminQuery(`UPDATE requests SET state='needs_review', last_error='wrong_shop_suspected' WHERE id=$1`,
      [(await intake.submit({ shopId, source: 'api', submissionId: 'na-1', content: 'x' })).requestId]);
    const na = await orders.needsAttention(shopId);
    expect(na.some((x) => x.reason === 'wrong_shop_suspected')).toBe(true);
    expect(await orders.needsAttention(shopB)).toHaveLength(0);
  });
});
