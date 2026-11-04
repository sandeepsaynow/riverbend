import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';
import { Db } from '../platform/db/index.js';
import { INTAKE_DLQ, INTAKE_QUEUE, PIPELINE_DLQ, PIPELINE_QUEUE } from '../platform/queue/index.js';
import { PgBossQueue } from '../platform/queue/pgboss-adapter.js';
import { FakeGateway } from '../platform/llm/fake-gateway.js';
import { LiteLlmGateway } from '../platform/llm/litellm-gateway.js';
import type { LlmGateway } from '../platform/llm/index.js';
import { PipelineService } from '../modules/pipeline/index.js';
import { OrdersService } from '../modules/orders/index.js';
import { processRequest } from './processor.js';
import { handleExhausted, reconcileOnce } from './sweeper.js';

/**
 * Worker process (active since 002; AI pipeline added in 003). Two stages: intake (received →
 * awaiting_pipeline, 002) then the AI pipeline (awaiting_pipeline → extracted/answered/awaiting_customer/
 * needs_review/held_budget, 003). pg-boss is the single retry authority. Logs ids only (FR-018). No AI
 * key is required to start — the FakeGateway is used unless a real LiteLLM provider is configured (B1).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = new Db({ appUrl: config.DATABASE_URL, adminUrl: config.DATABASE_ADMIN_URL });

  const gateway: LlmGateway =
    config.LLM_BASE_URL && config.LLM_MODEL
      ? new LiteLlmGateway(
          { baseUrl: config.LLM_BASE_URL, model: config.LLM_MODEL, apiKey: config.LLM_API_KEY, timeoutMs: config.LLM_TIMEOUT_MS },
          logger,
        )
      : new FakeGateway();
  logger.info({ gateway: gateway.name }, 'ai gateway selected');

  const orders = new OrdersService(db);
  const pipeline = new PipelineService(db, gateway, {
    defaultBudgetMicros: config.DEFAULT_SHOP_BUDGET_MICROS,
    estimateMicros: config.LLM_ESTIMATE_MICROS,
  });

  const queue = new PgBossQueue({
    ownerUrl: config.DATABASE_MIGRATOR_URL,
    maxAttempts: config.MAX_PROCESSING_ATTEMPTS,
    expireSeconds: config.QUEUE_EXPIRE_SECONDS,
  });
  await queue.start();

  // Stage 1 (002): intake → awaiting_pipeline, then hand off to the AI pipeline queue.
  await queue.work(INTAKE_QUEUE, async (payload) => {
    await processRequest(db, payload);
    await queue.publish(PIPELINE_QUEUE, payload);
  });
  // Stage 2 (003): the AI pipeline.
  await queue.work(PIPELINE_QUEUE, async (payload) => {
    await pipeline.run(payload);
    await orders.createFromExtraction(payload.shopId, payload.requestId); // 004: extracted → ordered
  });
  // Exhausted work in either stage parks needs_review.
  await queue.work(INTAKE_DLQ, (payload) => handleExhausted(db, payload));
  await queue.work(PIPELINE_DLQ, (payload) => handleExhausted(db, payload));

  const runReconcile = (): void => {
    reconcileOnce(db, queue).catch((err: unknown) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reconcile failed'),
    );
  };
  await reconcileOnce(db, queue);
  const timer = setInterval(runReconcile, config.RECONCILER_INTERVAL_MS);

  logger.info('worker started: intake + ai-pipeline + dead-letter + reconciler (ids only)');

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
