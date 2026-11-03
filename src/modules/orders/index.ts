import type { Db, PoolClient } from '../../platform/db/index.js';
import { PER_WHEEL } from '../pipeline/index.js';

interface ExtractionBike {
  bikeNumber: number;
  issues: string[];
  serviceCodes: string[];
  wheels?: ('front' | 'rear')[];
}
interface CatalogRow {
  code: string;
  name: string;
  price_cents: number;
  requires_inspection: boolean;
  catalog_version: string;
}
export interface OrderItem {
  code: string;
  name: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
  catalog_version: string;
  requires_inspection: boolean;
}
export interface WorkOrderView {
  id: string;
  request_id: string;
  bike_number: number;
  status: string;
  items: OrderItem[];
  order_total_cents: number;
}

export class OrdersService {
  constructor(private readonly db: Db) {}

  /**
   * Create one work order per bike from the request's validated extraction, in a single transaction,
   * pricing each line in code (unit × quantity, whole cents) and snapshotting price + catalog version
   * (D8/I5). Unique (shop, request, bike) makes it idempotent — a replay creates no duplicate (I2).
   * Only acts on a request in state `extracted`; afterwards sets it `ordered`.
   */
  async createFromExtraction(shopId: string, requestId: string): Promise<void> {
    await this.db.withTenant(shopId, async (c: PoolClient) => {
      const st = await c.query<{ state: string }>(`SELECT state FROM requests WHERE id=$1`, [requestId]);
      if (st.rows[0]?.state !== 'extracted') return; // not ready / already ordered — idempotent

      const exRes = await c.query<{ bikes: ExtractionBike[] }>(`SELECT bikes FROM extractions WHERE request_id=$1`, [requestId]);
      const bikes = exRes.rows[0]?.bikes;
      if (!bikes || bikes.length === 0) return;

      // Current catalog version + priced rows (snapshotted onto each item).
      const cat = await c.query<CatalogRow>(
        `SELECT code, name, price_cents, requires_inspection, catalog_version FROM catalog_service
          WHERE catalog_version = (SELECT catalog_version FROM catalog_service ORDER BY catalog_version DESC LIMIT 1)`,
      );
      const byCode = new Map(cat.rows.map((r) => [r.code, r]));

      for (const bike of bikes) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO work_orders (shop_id, request_id, bike_number) VALUES ($1, $2, $3)
           ON CONFLICT (shop_id, request_id, bike_number) DO NOTHING RETURNING id`,
          [shopId, requestId, bike.bikeNumber],
        );
        if (ins.rows.length === 0) continue; // order already exists for this bike (idempotent)
        const orderId = ins.rows[0]!.id;

        const counts = new Map<string, number>();
        for (const code of bike.serviceCodes) counts.set(code, (counts.get(code) ?? 0) + 1);
        for (const [code, count] of counts) {
          const entry = byCode.get(code);
          if (!entry) continue; // unknown code should have been rejected at validation (I3)
          const qty = PER_WHEEL.has(code) ? Math.max(1, bike.wheels?.length ?? 0) : count;
          const lineTotal = entry.price_cents * qty; // computed in code (I5), whole cents
          await c.query(
            `INSERT INTO work_order_items
               (shop_id, order_id, code, name, unit_price_cents, quantity, line_total_cents, catalog_version, requires_inspection)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [shopId, orderId, code, entry.name, entry.price_cents, qty, lineTotal, entry.catalog_version, entry.requires_inspection],
          );
        }
      }
      await c.query(`UPDATE requests SET state='ordered', updated_at=now() WHERE id=$1`, [requestId]);
    });
  }

  /** This shop's OPEN work orders with items, per-order totals, and a shop total (F5). RLS-scoped. */
  async listOpenOrders(shopId: string): Promise<{ orders: WorkOrderView[]; shop_total_cents: number }> {
    return this.db.withTenant(shopId, async (c) => {
      const ords = await c.query<{ id: string; request_id: string; bike_number: number; status: string }>(
        `SELECT id, request_id, bike_number, status FROM work_orders WHERE status='open' ORDER BY created_at`,
      );
      const orders: WorkOrderView[] = [];
      let shopTotal = 0;
      for (const o of ords.rows) {
        const items = await c.query<OrderItem>(
          `SELECT code, name, unit_price_cents, quantity, line_total_cents, catalog_version, requires_inspection
             FROM work_order_items WHERE order_id=$1 ORDER BY code`,
          [o.id],
        );
        const orderTotal = items.rows.reduce((s, i) => s + i.line_total_cents, 0);
        shopTotal += orderTotal;
        orders.push({ ...o, items: items.rows, order_total_cents: orderTotal });
      }
      return { orders, shop_total_cents: shopTotal };
    });
  }

  /** Requests needing attention (waiting/blocked), with reason + age. RLS-scoped. */
  async needsAttention(shopId: string): Promise<Array<{ request_id: string; state: string; reason: string | null; age_seconds: number }>> {
    return this.db.withTenant(shopId, async (c) => {
      const r = await c.query<{ request_id: string; state: string; reason: string | null; age_seconds: string }>(
        `SELECT id AS request_id, state, last_error AS reason,
                EXTRACT(EPOCH FROM (now() - updated_at))::int AS age_seconds
           FROM requests WHERE state IN ('needs_review','awaiting_customer','held_budget') ORDER BY updated_at`,
      );
      return r.rows.map((x) => ({ ...x, age_seconds: Number(x.age_seconds) }));
    });
  }
}
