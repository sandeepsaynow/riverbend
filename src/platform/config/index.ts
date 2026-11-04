import { z } from 'zod';

/**
 * Typed configuration from the environment (FR-014). A missing or empty REQUIRED setting makes
 * the process refuse to start with a message naming the setting — the system never runs
 * partially configured. No secret has a default (FR-021): ADMIN_BOOTSTRAP_TOKEN is required.
 */
const nonEmpty = z.string().trim().min(1);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Runtime, non-owner role (RLS forced): shop-scoped request handling.
  DATABASE_URL: nonEmpty,
  // Runtime admin role (permissive policy): admin/auth module only — the documented
  // cross-shop exception (D2: API-key lookup, provisioning).
  DATABASE_ADMIN_URL: nonEmpty,
  // Owner/migrator role: runs migrations only, never serves requests.
  DATABASE_MIGRATOR_URL: nonEmpty,
  // Initial administrative credential secret; fingerprinted at startup (FR-021). No default.
  ADMIN_BOOTSTRAP_TOKEN: nonEmpty,
  // Slice 002 intake/queue. Total processing attempts incl. the first (pg-boss retryLimit = this − 1).
  MAX_PROCESSING_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  // pg-boss job lease/expiration in seconds (drives crash recovery; above worst-case run).
  QUEUE_EXPIRE_SECONDS: z.coerce.number().int().positive().default(120),
  // Reconciler poll interval (ms): outbox-delivery backstop + exhaustion → needs_review.
  RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  // Slice 003 AI pipeline. Default per-shop monthly AI cap (micros = millionths USD); $5 default.
  DEFAULT_SHOP_BUDGET_MICROS: z.coerce.number().int().nonnegative().default(5_000_000),
  // Estimated cost reserved per model call (micros). Settled to real cost after the call.
  LLM_ESTIMATE_MICROS: z.coerce.number().int().positive().default(2_000),
  // Real provider (D6) — optional; when LLM_BASE_URL + LLM_MODEL are set, the worker routes through
  // the LiteLLM proxy instead of the fake (B1). LLM_API_KEY is the *proxy* key, never the backing
  // provider's key (that stays inside the proxy). LLM_TIMEOUT_MS bounds each model call.
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Budget authority (constitution 2.0.0). 'litellm' = the proxy enforces per-shop team budgets (sole
  // authority); 'legacy' = Riverbend reserve-then-settle hard cap (rollback). LLM_MASTER_KEY is used
  // ONLY to provision teams/virtual keys (admin path), never for inference.
  BUDGET_AUTHORITY: z.enum(['litellm', 'legacy']).default('litellm'),
  LLM_MASTER_KEY: z.string().optional(),
  LITELLM_TEAM_BUDGET_USD: z.coerce.number().positive().default(5),
  LITELLM_BUDGET_DURATION: z.string().default('30d'),
  // Slice 005 public web form (D11). The web surface is OFF unless WEB_FORM_SIGNING_KEY is set
  // (fail-closed; keeps the keyless default run). It signs per-shop form + status tokens (I8/III).
  WEB_FORM_SIGNING_KEY: z.string().optional(),
  // Comma-separated host allowlist for the public submit endpoint (empty → allow, for local dev).
  WEB_ALLOWED_ORIGINS: z.string().optional(),
  // Cloudflare Turnstile secret; when set, the real bot-check verifier is used (else a passing fake).
  TURNSTILE_SECRET: z.string().optional(),
  // Slice 006 email (D10 → D21: Resend sole provider). Reply-token correlation is OFF unless
  // EMAIL_SIGNING_KEY is set; outbound sends through Resend only when RESEND_API_KEY is set (else an
  // in-memory no-op locally); the inbound webhook mounts only when RESEND_WEBHOOK_SECRET is also set.
  EMAIL_SIGNING_KEY: z.string().optional(),        // signs reply tokens (reply+<token>@) — reply correlation
  RESEND_API_KEY: z.string().optional(),           // Resend SDK key (outbound send + inbound content fetch)
  RESEND_WEBHOOK_SECRET: z.string().optional(),    // Svix signing secret (whsec_…) for POST /webhooks/resend
  RESEND_FROM: z.string().default('Riverbend Cycles <onboarding@resend.dev>'), // verified sender (or resend.dev while testing)
  RESEND_REPLY_DOMAIN: z.string().default('riverbend.example'),                // reply+<token>@<this> (a Resend receiving domain)
  EMAIL_MAX_SEND_ATTEMPTS: z.coerce.number().int().positive().default(5),      // bounded outbound retry before needs_review
  // Slice 007 resilience (D13/D15/D16). The global "AI paused" switch → requests park held_budget.
  AI_PAUSED: z.string().default('false').transform((v) => v.toLowerCase() === 'true' || v === '1'),
  // Circuit breaker around the model call: open after N consecutive failures for a cooldown.
  AI_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  AI_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  // Per-shop bulkhead: max concurrent in-flight model calls for one shop.
  AI_MAX_CONCURRENCY_PER_SHOP: z.coerce.number().int().positive().default(4),
  // Slice 009: OpenAPI/Swagger at /docs. Enabled in non-production automatically; force with DOCS_ENABLED.
  DOCS_ENABLED: z.string().default('false').transform((v) => v.toLowerCase() === 'true' || v === '1'),
  // Slice 010 staff portal (Better Auth). Portal is OFF unless BETTER_AUTH_SECRET is set (fail-closed).
  // Better Auth uses the migrator (owner) connection for its global identity tables.
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().default('http://localhost:8080'),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

/** Parse and validate configuration, or throw ConfigError naming the offending setting(s). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as absent so an empty required var fails the same as a missing one.
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(ConfigSchema.shape)) {
    const raw = env[key];
    cleaned[key] = raw !== undefined && raw.trim() !== '' ? raw : undefined;
  }
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => i.path.join('.') || '(root)')
      .sort();
    throw new ConfigError(
      `Invalid configuration — refusing to start. Problem settings: ${[...new Set(missing)].join(', ')}`,
    );
  }
  return parsed.data;
}
