import { resolve } from 'node:path';
import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';
import { Db } from '../platform/db/index.js';
import { runMigrations, schemaState } from '../platform/db/migrate.js';
import { findPolicyGaps } from '../platform/db/policy-check.js';
import { AuthService } from '../modules/auth/index.js';
import { ShopsService } from '../modules/shops/index.js';
import { provisionDefaultShops } from '../modules/shops/provision.js';
import { CatalogService } from '../modules/catalog/index.js';
import { IntakeService } from '../modules/intake/index.js';
import { OrdersService } from '../modules/orders/index.js';
import { WebService } from '../modules/web/index.js';
import { CloudflareTurnstileVerifier, FakeTurnstileVerifier } from '../modules/web/turnstile.js';
import { EmailService } from '../modules/email/index.js';
import { SvixVerifier } from '../modules/email/resend-webhook.js';
import pg from 'pg';
import { createAuth, trustedOriginsFor } from '../platform/auth/better-auth.js';
import { createApp } from './app.js';

const CATALOG_PATH = process.env.CATALOG_PATH ?? resolve(process.cwd(), 'catalog/catalog.json');

async function main(): Promise<void> {
  // 1. Config: refuse to start on missing/empty required settings or admin token (FR-014/FR-021).
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // 2. Migrate-before-serve (FR-022): apply migrations as the owner role.
  await runMigrations(config.DATABASE_MIGRATOR_URL);

  const db = new Db({ appUrl: config.DATABASE_URL, adminUrl: config.DATABASE_ADMIN_URL });

  // 3. Fail closed on an incompatible or unpoliced schema — never serve protected requests (FR-022).
  const state = await schemaState(config.DATABASE_ADMIN_URL);
  if (state.pending.length > 0 || state.unknown.length > 0) {
    throw new Error(
      `Schema not compatible (pending=${state.pending.join(',')} unknown=${state.unknown.join(',')}); refusing to serve`,
    );
  }
  const gaps = await findPolicyGaps(db);
  if (gaps.length > 0) {
    throw new Error(`Missing/forced isolation policy on: ${JSON.stringify(gaps)}; refusing to serve`);
  }

  // 4. Fail-closed bootstrap admin credential (FR-021). No default/hardcoded credential.
  const auth = new AuthService(db);
  await auth.ensureBootstrapAdmin(config.ADMIN_BOOTSTRAP_TOKEN);

  // 5. Shared reference data + services.
  const shops = new ShopsService(db);
  const catalog = new CatalogService(db);
  await catalog.seedFromFile(CATALOG_PATH);

  // Auto-provision the three default shops + inbound addresses (D31) — idempotent, no key issuance, no
  // order changes. Makes a fresh `make up`/deploy ready to use (previously shops only existed after a manual
  // `make provision`). Off with AUTO_PROVISION_SHOPS=false.
  if (config.AUTO_PROVISION_SHOPS) {
    const domain = config.RESEND_INBOUND_DOMAIN ?? config.RESEND_REPLY_DOMAIN;
    const r = await provisionDefaultShops(shops, { inboundDomain: domain });
    logger.info({ shops: r.map((s) => s.slug), created: r.filter((s) => s.created).length, inboundDomain: domain }, 'default shops provisioned');
  }
  const intake = new IntakeService(db);
  const orders = new OrdersService(db);

  // Public web form (005) — only when a signing key is configured (fail-closed; keyless runs skip it).
  const web = config.WEB_FORM_SIGNING_KEY
    ? new WebService(db, intake, {
        signingKey: config.WEB_FORM_SIGNING_KEY,
        turnstile: config.TURNSTILE_SECRET
          ? new CloudflareTurnstileVerifier(config.TURNSTILE_SECRET)
          : new FakeTurnstileVerifier(),
      })
    : undefined;
  if (web) logger.info('public web form enabled (/f)');

  // Inbound Resend webhook (006/D21) — only with a reply-token signing key + a Svix webhook secret
  // (fail-closed). The api process holds no provider API key; it only verifies + records the event.
  const email = config.EMAIL_SIGNING_KEY
    ? new EmailService(db, {
        signingKey: config.EMAIL_SIGNING_KEY,
        fromAddress: config.RESEND_FROM,
        replyDomain: config.RESEND_REPLY_DOMAIN,
        maxSendAttempts: config.EMAIL_MAX_SEND_ATTEMPTS,
      })
    : undefined;
  // Construct the Svix verifier defensively: svix validates/decodes the secret in its constructor, so a
  // malformed RESEND_WEBHOOK_SECRET must NOT crash the whole API — it just disables the optional webhook
  // (fail-closed; polling-mode inbound is unaffected, D21.1).
  let emailVerifier: SvixVerifier | undefined;
  if (config.RESEND_WEBHOOK_SECRET) {
    try {
      emailVerifier = new SvixVerifier(config.RESEND_WEBHOOK_SECRET);
    } catch {
      logger.warn('RESEND_WEBHOOK_SECRET is not a valid Svix signing secret — inbound webhook disabled (polling-mode inbound is unaffected)');
    }
  }
  if (email && emailVerifier) logger.info('inbound Resend webhook enabled (/webhooks/resend)');

  // Staff portal (010) — only when BETTER_AUTH_SECRET is set. Better Auth uses its OWN Pool on the
  // migrator (owner) role for its global identity tables (never under tenant RLS).
  // Hoist Better Auth's migrator Pool so the portal service can reuse it for bootstrap-reconciliation
  // identity reads (D20.1) — the same global identity DB Better Auth owns.
  const authPool = config.BETTER_AUTH_SECRET ? new pg.Pool({ connectionString: config.DATABASE_MIGRATOR_URL }) : undefined;
  const betterAuth = authPool
    ? createAuth({
        pool: authPool,
        secret: config.BETTER_AUTH_SECRET!,
        baseURL: config.BETTER_AUTH_URL,
        trustedOrigins: trustedOriginsFor(config.BETTER_AUTH_URL, config.NODE_ENV === 'production'),
        secureCookies: config.NODE_ENV === 'production',
      })
    : undefined;
  if (betterAuth) logger.info('staff portal enabled (/admin, /staff, /api/auth)');

  // 6. Serve.
  const app = createApp({ config, db, logger, auth, shops, catalog, intake, orders, ...(web ? { web } : {}), ...(email ? { email } : {}), ...(emailVerifier ? { emailVerifier } : {}), ...(betterAuth ? { betterAuth } : {}), ...(authPool ? { authPool } : {}) });
  app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
