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
