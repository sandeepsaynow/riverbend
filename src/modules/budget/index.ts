import type { Db, PoolClient } from '../../platform/db/index.js';

/** AI spend is tracked in whole millionths of a dollar (micros), per D8. */
export interface ReserveInput {
  shopId: string;
  requestId: string;
  period: string; // 'YYYY-MM'
  step: string; // e.g. 'extract'
  attempt: number; // 1-based
  estimateMicros: number;
}
export interface ReserveResult {
  ok: boolean; // false => over cap (park held_budget)
  reused: boolean; // true => replay of an existing receipt (no new charge)
  callId?: string;
}

export class BudgetService {
  constructor(private readonly db: Db) {}

  /** Create/raise a shop's monthly cap. Raising the cap is how held work resumes (D7). */
  async ensureBudget(shopId: string, period: string, capMicros: number): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(
        `INSERT INTO shop_budgets (shop_id, period, cap_micros) VALUES ($1, $2, $3)
         ON CONFLICT (shop_id, period) DO UPDATE SET cap_micros = EXCLUDED.cap_micros`,
        [shopId, period, capMicros],
      ),
    );
  }

  /**
   * Reserve an estimate atomically (I4). One transaction: write the (request, step, attempt) receipt,
   * then `reserved += estimate` only if `spent + reserved + estimate <= cap`. A replayed key reuses the
   * existing receipt and does NOT charge again. Over cap → ok:false (no receipt left behind).
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    return this.db.withTenant(input.shopId, async (c: PoolClient) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO llm_calls (shop_id, request_id, period, step, attempt, estimate_micros, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'reserved')
         ON CONFLICT (shop_id, request_id, step, attempt) DO NOTHING
         RETURNING id`,
        [input.shopId, input.requestId, input.period, input.step, input.attempt, input.estimateMicros],
      );

      if (ins.rows.length === 0) {
        // Replay: the receipt already exists → reuse it, no second charge.
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM llm_calls WHERE shop_id=$1 AND request_id=$2 AND step=$3 AND attempt=$4`,
          [input.shopId, input.requestId, input.step, input.attempt],
        );
        const existingId = existing.rows[0]?.id;
        return existingId
          ? { ok: true, reused: true, callId: existingId }
          : { ok: true, reused: true };
      }

      const callId = ins.rows[0]!.id;
      const upd = await c.query(
        `UPDATE shop_budgets
            SET reserved_micros = reserved_micros + $3
          WHERE shop_id = $1 AND period = $2
            AND spent_micros + reserved_micros + $3 <= cap_micros`,
        [input.shopId, input.period, input.estimateMicros],
      );
      if ((upd.rowCount ?? 0) === 0) {
        // Over cap (or no budget row) → undo the receipt so none is left reserved.
        await c.query(`DELETE FROM llm_calls WHERE id = $1`, [callId]);
        return { ok: false, reused: false };
      }
      return { ok: true, reused: false, callId };
    });
  }

  /** Settle a reserved call at its real cost (idempotent): reserved -= estimate, spent += cost. */
  async settle(shopId: string, callId: string, costMicros: number): Promise<void> {
    await this.db.withTenant(shopId, async (c) => {
      const row = await c.query<{ estimate_micros: string; period: string }>(
        `UPDATE llm_calls SET cost_micros = $2, status = 'settled', settled_at = now()
          WHERE id = $1 AND status = 'reserved'
          RETURNING estimate_micros, period`,
        [callId, costMicros],
      );
      const r = row.rows[0];
      if (!r) return; // already settled / unknown — idempotent no-op
      await c.query(
        `UPDATE shop_budgets
            SET reserved_micros = reserved_micros - $3, spent_micros = spent_micros + $4
          WHERE shop_id = $1 AND period = $2`,
        [shopId, r.period, Number(r.estimate_micros), costMicros],
      );
    });
  }

  /** Reap abandoned reservations (crash) by settling them at their estimate — budget never leaks. */
  async reapOlderThan(shopId: string, seconds: number): Promise<number> {
    return this.db.withTenant(shopId, async (c) => {
      const stale = await c.query<{ id: string; estimate_micros: string }>(
        `SELECT id, estimate_micros FROM llm_calls
          WHERE status = 'reserved' AND created_at < now() - ($1 || ' seconds')::interval`,
        [String(seconds)],
      );
      for (const row of stale.rows) {
        await c.query(
          `UPDATE llm_calls SET cost_micros = estimate_micros, status = 'settled', settled_at = now() WHERE id = $1`,
          [row.id],
        );
        await c.query(
          `UPDATE shop_budgets SET reserved_micros = reserved_micros - $2, spent_micros = spent_micros + $2
            WHERE shop_id = $1 AND period = (SELECT period FROM llm_calls WHERE id = $3)`,
          [shopId, Number(row.estimate_micros), row.id],
        );
      }
      return stale.rows.length;
    });
  }

  /**
   * Accounting-only record for the LiteLLM-sole-authority mode (constitution 2.0.0): persist the
   * proxy-calculated cost + usage per call, idempotent on (shop, request, step, attempt) so a replay
   * never double-counts. No reservation math and no cap check — the proxy owns enforcement.
   */
  async recordUsage(
    shopId: string,
    rec: { requestId: string; period: string; step: string; attempt: number; costMicros: number; model?: string | undefined; promptTokens?: number | undefined; completionTokens?: number | undefined; providerRequestId?: string | undefined },
  ): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(
        `INSERT INTO llm_calls (shop_id, request_id, period, step, attempt, estimate_micros, cost_micros, status, settled_at, model, prompt_tokens, completion_tokens, provider_request_id, cost_source)
         VALUES ($1,$2,$3,$4,$5,0,$6,'settled',now(),$7,$8,$9,$10,'proxy_calculated')
         ON CONFLICT (shop_id, request_id, step, attempt) DO NOTHING`,
        [shopId, rec.requestId, rec.period, rec.step, rec.attempt, rec.costMicros, rec.model ?? null, rec.promptTokens ?? null, rec.completionTokens ?? null, rec.providerRequestId ?? null],
      ),
    );
  }

  async usage(shopId: string, period: string): Promise<{ capMicros: number; spentMicros: number; reservedMicros: number } | null> {
    return this.db.withTenant(shopId, async (c) => {
      const r = await c.query<{ cap_micros: string; spent_micros: string; reserved_micros: string }>(
        `SELECT cap_micros, spent_micros, reserved_micros FROM shop_budgets WHERE shop_id=$1 AND period=$2`,
        [shopId, period],
      );
      const row = r.rows[0];
      return row
        ? { capMicros: Number(row.cap_micros), spentMicros: Number(row.spent_micros), reservedMicros: Number(row.reserved_micros) }
        : null;
    });
  }
}
