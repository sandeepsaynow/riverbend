import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';
import { Db } from '../platform/db/index.js';
import { INTAKE_DLQ, INTAKE_QUEUE, PIPELINE_DLQ, PIPELINE_QUEUE } from '../platform/queue/index.js';
import { PgBossQueue } from '../platform/queue/pgboss-adapter.js';
import { FakeGateway } from '../platform/llm/fake-gateway.js';
import { LiteLlmGateway } from '../platform/llm/litellm-gateway.js';
import { ResilientGateway } from '../platform/llm/resilient-gateway.js';
import type { LlmGateway } from '../platform/llm/index.js';
import { PipelineService } from '../modules/pipeline/index.js';
import { LiteLlmAdmin, LiteLlmProvisioner } from '../modules/budget/litellm-admin.js';
import { OrdersService } from '../modules/orders/index.js';
import { EmailService } from '../modules/email/index.js';
import { InMemoryEmailTransport, MailpitTransport, type EmailTransport } from '../modules/email/transport.js';
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

  const baseGateway: LlmGateway =
    config.LLM_BASE_URL && config.LLM_MODEL
      ? new LiteLlmGateway(
          { baseUrl: config.LLM_BASE_URL, model: config.LLM_MODEL, apiKey: config.LLM_API_KEY, timeoutMs: config.LLM_TIMEOUT_MS },
          logger,
        )
      : new FakeGateway();
  // Wrap with resilience (007): AI-paused switch + circuit breaker + per-shop bulkhead, over the
  // delegate's own per-call timeout. pg-boss stays the sole retry authority.
  const gateway: LlmGateway = new ResilientGateway(baseGateway, {
    failureThreshold: config.AI_CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs: config.AI_CIRCUIT_COOLDOWN_MS,
    maxConcurrentPerShop: config.AI_MAX_CONCURRENCY_PER_SHOP,
    isPaused: () => config.AI_PAUSED,
  });
  logger.info({ gateway: baseGateway.name, paused: config.AI_PAUSED }, 'ai gateway selected (resilience wrapped)');

  const orders = new OrdersService(db);

  // Budget authority (2.0.0): in 'litellm' mode with a proxy + master key, provision a team/virtual key
  // per shop and let the proxy enforce. Otherwise (legacy, or offline fake) no provisioner is wired.
  let resolveKey: ((shopId: string) => Promise<string>) | undefined;
  if (config.BUDGET_AUTHORITY === 'litellm' && config.LLM_BASE_URL && config.LLM_MASTER_KEY) {
    const admin = new LiteLlmAdmin({ baseUrl: config.LLM_BASE_URL, masterKey: config.LLM_MASTER_KEY });
    const provisioner = new LiteLlmProvisioner(db, admin, { budgetUsd: config.LITELLM_TEAM_BUDGET_USD, budgetDuration: config.LITELLM_BUDGET_DURATION });
    resolveKey = (shopId) => provisioner.ensureVirtualKey(shopId);
    logger.info({ budgetAuthority: 'litellm' }, 'budget enforcement: LiteLLM-native (per-shop teams/keys)');
  } else {
    logger.info({ budgetAuthority: config.BUDGET_AUTHORITY, provisioner: false }, 'budget enforcement');
  }

  const pipeline = new PipelineService(db, gateway, {
    defaultBudgetMicros: config.DEFAULT_SHOP_BUDGET_MICROS,
    estimateMicros: config.LLM_ESTIMATE_MICROS,
    budgetAuthority: config.BUDGET_AUTHORITY,
    ...(resolveKey ? { resolveKey } : {}),
  });

  // Email (006): send the one clarification question + relay pending outbound mail. Off unless an
  // EMAIL_SIGNING_KEY is set; SMTP transport only when MAIL_SMTP_HOST is set (else an in-memory no-op).
  const email = config.EMAIL_SIGNING_KEY
    ? new EmailService(db, { signingKey: config.EMAIL_SIGNING_KEY, fromAddress: config.MAIL_FROM, replyDomain: config.MAIL_REPLY_DOMAIN })
    : undefined;
  const mailTransport: EmailTransport = config.MAIL_SMTP_HOST
    ? new MailpitTransport({ host: config.MAIL_SMTP_HOST, port: config.MAIL_SMTP_PORT, from: config.MAIL_FROM })
    : new InMemoryEmailTransport();
  if (email) logger.info({ smtp: config.MAIL_SMTP_HOST ?? 'in-memory' }, 'email enabled');

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
  // Stage 2 (003): the AI pipeline, then orders (004) and the clarification email (006).
  await queue.work(PIPELINE_QUEUE, async (payload) => {
    await pipeline.run(payload);
    await orders.createFromExtraction(payload.shopId, payload.requestId); // 004: extracted → ordered
    if (email) {
      const st = await intakeState(db, payload.shopId, payload.requestId);
      if (st === 'awaiting_customer') await email.enqueueFollowUp(payload.shopId, payload.requestId); // 006
    }
  });
  // Exhausted work in either stage parks needs_review.
  await queue.work(INTAKE_DLQ, (payload) => handleExhausted(db, payload));
  await queue.work(PIPELINE_DLQ, (payload) => handleExhausted(db, payload));

  const runReconcile = (): void => {
    reconcileOnce(db, queue).catch((err: unknown) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reconcile failed'),
    );
    if (email) {
      email.relayPending(mailTransport).catch((err: unknown) =>
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'email relay failed'),
      );
    }
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

/** Read a request's current state within its tenant (ids only). */
async function intakeState(db: Db, shopId: string, requestId: string): Promise<string | null> {
  return db.withTenant(shopId, async (c) => {
    const r = await c.query<{ state: string }>(`SELECT state FROM requests WHERE id = $1`, [requestId]);
    return r.rows[0]?.state ?? null;
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
