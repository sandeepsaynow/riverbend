import type { Db } from '../platform/db/index.js';
import type { JobPayload } from '../platform/queue/index.js';

/**
 * Process one intake job (ids only). Runs as `app_user` bound to the job's shop (RLS holds during
 * processing). Advances `received → processing → awaiting_pipeline` **idempotently**: a redelivered or
 * replayed job is a no-op once the request is already `awaiting_pipeline` (or parked). No AI, no
 * message content is read. On failure this throws so pg-boss (the sole retry authority) retries.
 */
export async function processRequest(db: Db, payload: JobPayload): Promise<void> {
  await db.withTenant(payload.shopId, async (client) => {
    const res = await client.query<{ state: string }>(
      `SELECT state FROM requests WHERE id = $1`,
      [payload.requestId],
    );
    const row = res.rows[0];
    if (!row) return; // unknown/not visible in this tenant — nothing to do
    if (row.state === 'awaiting_pipeline' || row.state === 'needs_review') return; // idempotent / terminal

    await client.query(
      `UPDATE requests
          SET state = 'processing', processing_started_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [payload.requestId],
    );
    // Deterministic step for slice 002: NO interpretation, NO AI — intake is complete.
    await client.query(
      `UPDATE requests SET state = 'awaiting_pipeline', updated_at = now() WHERE id = $1`,
      [payload.requestId],
    );
  });
}
