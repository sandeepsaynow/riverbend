import type { Db } from '../platform/db/index.js';
import type { JobPayload, JobQueue } from '../platform/queue/index.js';
import { relayOnce } from './relay.js';

/**
 * Reconciler (not a retrier). It reconciles request status with durable queue state; it NEVER
 * re-enqueues processing work — pg-boss owns retries. Here it re-runs outbox **delivery** (the
 * relay) as a backstop so no accepted message is lost (FR-010). Retry scheduling, backoff, and the
 * attempt limit all live in pg-boss.
 */
export async function reconcileOnce(db: Db, queue: JobQueue): Promise<number> {
  return relayOnce(db, queue);
}

/**
 * Automatic recovery for requests parked at `held_budget` (D25). A held request completed its job cleanly
 * (no exception) and so pg-boss will never retry it; it is waiting for the shop's cap to reset/raise or the
 * AI-paused switch to clear. This re-drives such requests through the SANCTIONED new-work path — a fresh
 * `job_outbox` row the relay publishes — rather than re-enqueuing a pg-boss job (so pg-boss stays the sole
 * retry authority). The pipeline then re-checks the budget and either proceeds or re-parks `held_budget`
 * (no model spend on a denied admission). Bounded: only requests whose `updated_at` is older than
 * `minAgeSeconds` are eligible, and a re-park renews `updated_at`, so each request is re-driven at most once
 * per cooldown. Returns the number re-driven. Caller gates on "AI not paused" to avoid pointless churn.
 */
export async function recoverHeldBudget(db: Db, minAgeSeconds: number, limit = 50): Promise<number> {
  if (minAgeSeconds <= 0) return 0; // disabled
  const res = await db.adminQuery<{ request_id: string }>(
    `WITH due AS (
       SELECT shop_id, id AS request_id
         FROM requests
        WHERE state = 'held_budget' AND updated_at < now() - ($1 || ' seconds')::interval
        ORDER BY updated_at
        LIMIT $2
     )
     INSERT INTO job_outbox (shop_id, request_id, status)
     SELECT shop_id, request_id, 'pending' FROM due
     RETURNING request_id`,
    [String(minAgeSeconds), limit],
  );
  return res.rows.length;
}

/**
 * Dead-letter handler: a job that pg-boss has retried to exhaustion lands on the dead-letter queue.
 * Preserve the intake record and transition the request to the visible `needs_review` state (FR-011).
 * Runs as `app_user` bound to the job's shop.
 */
export async function handleExhausted(db: Db, payload: JobPayload): Promise<void> {
  await db.withTenant(payload.shopId, async (client) => {
    await client.query(
      `UPDATE requests
          SET state = 'needs_review', last_error = 'processing attempts exhausted', updated_at = now()
        WHERE id = $1 AND state <> 'awaiting_pipeline'`,
      [payload.requestId],
    );
  });
}
