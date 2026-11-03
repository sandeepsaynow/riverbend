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
