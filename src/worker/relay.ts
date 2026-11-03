import type { Db } from '../platform/db/index.js';
import { INTAKE_QUEUE, type JobQueue } from '../platform/queue/index.js';

/**
 * Transactional-outbox relay (delivery, NOT retry). Publishes `pending` outbox rows to pg-boss, then
 * marks them `published`. Publishing before marking means a crash republishes next cycle — safe
 * because the processor is idempotent. Reads ids only as `app_admin` (cross-shop; D2 exception).
 * This is also the reconciler's delivery backstop: any unpublished intent is re-derived (FR-010).
 */
export async function relayOnce(db: Db, queue: JobQueue): Promise<number> {
  const pending = await db.adminQuery<{ id: string; shop_id: string; request_id: string }>(
    `SELECT id, shop_id, request_id FROM job_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
  );
  for (const row of pending.rows) {
    await queue.publish(INTAKE_QUEUE, { requestId: row.request_id, shopId: row.shop_id });
    await db.adminQuery(
      `UPDATE job_outbox SET status = 'published', published_at = now() WHERE id = $1`,
      [row.id],
    );
  }
  return pending.rows.length;
}
