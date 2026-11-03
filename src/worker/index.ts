import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';
import { Db } from '../platform/db/index.js';
import { INTAKE_DLQ, INTAKE_QUEUE } from '../platform/queue/index.js';
import { PgBossQueue } from '../platform/queue/pgboss-adapter.js';
import { processRequest } from './processor.js';
import { handleExhausted, reconcileOnce } from './sweeper.js';

/**
 * Worker process (active from slice 002). Starts pg-boss, the intake processor, the dead-letter
 * handler, and the reconciler loop. No AI. Logs **ids only** — never message content (FR-018).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = new Db({ appUrl: config.DATABASE_URL, adminUrl: config.DATABASE_ADMIN_URL });

  // pg-boss is the single retry authority; it owns its schema via the owner/migrator connection.
  const queue = new PgBossQueue({
    ownerUrl: config.DATABASE_MIGRATOR_URL,
    maxAttempts: config.MAX_PROCESSING_ATTEMPTS,
    expireSeconds: config.QUEUE_EXPIRE_SECONDS,
  });
  await queue.start();

  await queue.work(INTAKE_QUEUE, (payload) => processRequest(db, payload));
  await queue.work(INTAKE_DLQ, (payload) => handleExhausted(db, payload));

  // Reconciler: outbox-delivery backstop (not a retry loop).
  const runReconcile = (): void => {
    reconcileOnce(db, queue).catch((err: unknown) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reconcile failed'),
    );
  };
  await reconcileOnce(db, queue); // drain on startup
  const timer = setInterval(runReconcile, config.RECONCILER_INTERVAL_MS);

  logger.info('worker started: intake processor + dead-letter + reconciler (ids only, no AI)');

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await queue.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
