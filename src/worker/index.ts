import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';
import { Db } from '../platform/db/index.js';
import { EMAIL_POLL_QUEUE, INTAKE_DLQ, INTAKE_QUEUE, PIPELINE_DLQ, PIPELINE_QUEUE } from '../platform/queue/index.js';
import { PgBossQueue } from '../platform/queue/pgboss-adapter.js';
import { FakeGateway } from '../platform/llm/fake-gateway.js';
import { LiteLlmGateway } from '../platform/llm/litellm-gateway.js';
import { ResilientGateway } from '../platform/llm/resilient-gateway.js';
import type { LlmGateway } from '../platform/llm/index.js';
import { PipelineService } from '../modules/pipeline/index.js';
import { LiteLlmAdmin, LiteLlmProvisioner } from '../modules/budget/litellm-admin.js';
import { LiteLlmShopRoutingClassifier, LlmShopResolver } from '../modules/email/shop-router-llm.js';
import { OrdersService } from '../modules/orders/index.js';
import { IntakeService } from '../modules/intake/index.js';
import { ShopsService } from '../modules/shops/index.js';
import { EmailService } from '../modules/email/index.js';
import { startHealthServer } from './health-server.js';
import { InMemoryEmailTransport, ResendTransport, type EmailTransport } from '../modules/email/transport.js';
import { ResendReceiving, type ReceivingClient, type ReceivingLister } from '../modules/email/receiving.js';
import { processRequest } from './processor.js';
import { handleExhausted, reconcileOnce, recoverHeldBudget } from './sweeper.js';

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

  // Cloud Run runs the worker as a *service*, whose startup/liveness probes need a listener on $PORT
  // even though the worker serves no API (D25). Bind early so the probe passes; flip ready once wired.
  let ready = false;
  const healthServer = startHealthServer(config.PORT, () => ready);

  // Native budget mode: the proxy enforces per-shop team budgets and the worker provisions per-shop
  // virtual keys. In this mode the gateway carries NO default key — every inference MUST present a
  // per-shop virtual key (fail-closed); LLM_API_KEY is NOT an inference fallback and the master key is
  // never used for inference. Legacy mode keeps LLM_API_KEY as the single proxy key.
  const nativeBudget = config.BUDGET_AUTHORITY === 'litellm' && !!config.LLM_BASE_URL && !!config.LLM_MASTER_KEY;
  const baseGateway: LlmGateway =
    config.LLM_BASE_URL && config.LLM_MODEL
      ? new LiteLlmGateway(
          {
            baseUrl: config.LLM_BASE_URL,
            model: config.LLM_MODEL,
            ...(nativeBudget ? {} : { apiKey: config.LLM_API_KEY }),
            timeoutMs: config.LLM_TIMEOUT_MS,
          },
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
  const intake = new IntakeService(db);
  const shops = new ShopsService(db);

  // Budget authority (2.0.0): in 'litellm' mode with a proxy + master key, provision a team/virtual key
  // per shop and let the proxy enforce. Otherwise (legacy, or offline fake) no provisioner is wired.
  let resolveKey: ((shopId: string) => Promise<string>) | undefined;
  if (nativeBudget) {
    const admin = new LiteLlmAdmin({ baseUrl: config.LLM_BASE_URL!, masterKey: config.LLM_MASTER_KEY! });
    const provisioner = new LiteLlmProvisioner(db, admin, { budgetUsd: config.LITELLM_TEAM_BUDGET_USD, budgetDuration: config.LITELLM_BUDGET_DURATION });
    resolveKey = (shopId) => provisioner.ensureVirtualKey(shopId);
    logger.info({ budgetAuthority: 'litellm' }, 'budget enforcement: LiteLLM-native (per-shop teams/keys)');
  } else {
    logger.info({ budgetAuthority: config.BUDGET_AUTHORITY, provisioner: false }, 'budget enforcement');
  }

  // D34: pre-tenant shop routing. Default = deterministic D32 regex. When LLM routing is enabled and a proxy
  // is configured, route via GPT-5.4 mini on a SEPARATE, tightly-capped routing key (fail-closed over budget
  // → regex fallback). Code validates the slug and assigns the tenant; the LLM never assigns tenant_id.
  let routeByContent: (text: string) => Promise<string[]> = (text) => shops.resolveShopByContent(text);
  if (config.LLM_ROUTING_ENABLED && nativeBudget && config.LLM_MODEL) {
    try {
      const radmin = new LiteLlmAdmin({ baseUrl: config.LLM_BASE_URL!, masterKey: config.LLM_MASTER_KEY! });
      const team = await radmin.createTeam(`routing:${Date.now()}`, config.LITELLM_ROUTING_BUDGET_USD, config.LITELLM_BUDGET_DURATION);
      const routingKey = await radmin.createVirtualKey(team, 'routing:pre-tenant');
      const classifier = new LiteLlmShopRoutingClassifier({ baseUrl: config.LLM_BASE_URL!, model: config.LLM_MODEL, apiKey: routingKey, timeoutMs: config.LLM_TIMEOUT_MS, maxRetries: 1 });
      const resolver = new LlmShopResolver(
        classifier,
        { listShops: () => shops.listShops().then((r) => r.map((s) => ({ id: s.id, slug: s.slug }))), resolveShopByContent: (txt) => shops.resolveShopByContent(txt) },
        { minConfidence: config.LLM_ROUTING_MIN_CONFIDENCE },
      );
      routeByContent = (text) => resolver.resolve(text);
      logger.info({ budgetUsd: config.LITELLM_ROUTING_BUDGET_USD, minConfidence: config.LLM_ROUTING_MIN_CONFIDENCE }, 'LLM shop routing enabled (capped pre-tenant key; regex fallback)');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'LLM routing provisioning failed; using deterministic regex routing');
    }
  }

  const pipeline = new PipelineService(db, gateway, {
    defaultBudgetMicros: config.DEFAULT_SHOP_BUDGET_MICROS,
    estimateMicros: config.LLM_ESTIMATE_MICROS,
    budgetAuthority: config.BUDGET_AUTHORITY,
    ...(resolveKey ? { resolveKey } : {}),
  });

  // Email (006/D21): send the one clarification question + relay pending outbound mail, and drain
  // inbound provider events. Off unless EMAIL_SIGNING_KEY is set; Resend transport + Receiving client
  // only when RESEND_API_KEY is set (else an in-memory no-op — keyless default + offline tests).
  const email = config.EMAIL_SIGNING_KEY
    ? new EmailService(
        db,
        {
          signingKey: config.EMAIL_SIGNING_KEY,
          fromAddress: config.RESEND_FROM,
          replyDomain: config.RESEND_REPLY_DOMAIN,
          maxSendAttempts: config.EMAIL_MAX_SEND_ATTEMPTS,
        },
        // New-inbound intake (D25): resolve a verified destination address → shop, then submit a new
        // request. Only wired in the worker (where inbound is drained); the API process stays reply-only.
        {
          router: {
            resolveShopByInboundAddress: (addr) => shops.resolveByInboundAddress(addr),
            resolveShopByContent: (text) => routeByContent(text), // D34 LLM routing (regex fallback)
          },
          intake,
        },
      )
    : undefined;
  const mailTransport: EmailTransport = config.RESEND_API_KEY
    ? new ResendTransport(config.RESEND_API_KEY, config.RESEND_FROM)
    : new InMemoryEmailTransport();
  const receiving: (ReceivingClient & ReceivingLister) | undefined = config.RESEND_API_KEY ? new ResendReceiving(config.RESEND_API_KEY) : undefined;
  if (email) logger.info({ provider: config.RESEND_API_KEY ? 'resend' : 'in-memory' }, 'email enabled');

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
    // Re-drive budget-held requests once the cooldown passes (D25) — skip while AI is deliberately paused.
    if (!config.AI_PAUSED && config.HELD_BUDGET_RETRY_SECONDS > 0) {
      recoverHeldBudget(db, config.HELD_BUDGET_RETRY_SECONDS)
        .then((n) => { if (n > 0) logger.info({ count: n }, 'held_budget requests re-driven for recovery'); })
        .catch((err: unknown) => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'held_budget recovery failed'));
    }
    if (email) {
      email.relayPending(mailTransport).catch((err: unknown) =>
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'email relay failed'),
      );
      // D32: send one shop-clarification for each pending-intake email awaiting a shop (reply-safe, bounded).
      email.relayPendingClarifications(mailTransport).catch((err: unknown) =>
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'pending clarification relay failed'),
      );
      // Drain inbound/delivery provider events (fetch content + correlate; update send status).
      if (receiving) {
        email.processPendingEvents(receiving).catch((err: unknown) =>
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'email event drain failed'),
        );
      }
    }
  };
  await reconcileOnce(db, queue);
  const timer = setInterval(runReconcile, config.RECONCILER_INTERVAL_MS);

  // Inbound by Resend Receiving-API polling (006/D21.1) — the default local/MVP inbound path (no webhook,
  // URL, or tunnel). A self-rescheduling pg-boss singleton discovers new emails, then the existing
  // event-drain fetches content + correlates. Off unless RESEND_POLLING_ENABLED + RESEND_API_KEY + email.
  if (email && receiving && config.RESEND_POLLING_ENABLED && config.RESEND_API_KEY) {
    await queue.workPoll(EMAIL_POLL_QUEUE, config.RESEND_POLL_INTERVAL_SECONDS, async () => {
      try {
        const r = await email.pollOnce(receiving);
        if (!r.skipped) await email.processPendingEvents(receiving);
      } catch (err) {
        // Surface a failing poll (e.g. an invalid RESEND_API_KEY → 401) instead of failing silently;
        // the next interval retries. No email content or credential is logged (VII).
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'resend inbound poll failed (will retry next interval)');
      }
    });
    await queue.schedulePoll(EMAIL_POLL_QUEUE, 0); // kick immediately; singletonKey dedups across restarts
    logger.info({ intervalSeconds: config.RESEND_POLL_INTERVAL_SECONDS }, 'resend inbound polling enabled');
  }

  ready = true; // queue + handlers wired → readiness probe can report ready
  logger.info('worker started: intake + ai-pipeline + dead-letter + reconciler (ids only)');

  const shutdown = async (): Promise<void> => {
    ready = false;
    clearInterval(timer);
    healthServer.close();
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
