import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Config } from '../platform/config/index.js';
import type { Db } from '../platform/db/index.js';
import type { Logger } from '../platform/observability/logger.js';
import { createRouter } from '../platform/http/typed-route.js';
import { errorHandler } from '../platform/http/error-handler.js';
import { AuthService } from '../modules/auth/index.js';
import { adminAuth, shopAuth } from '../modules/auth/middleware.js';
import { registerAdminCredentialRoutes } from '../modules/auth/routes.js';
import { ShopsService } from '../modules/shops/index.js';
import { registerAdminShopRoutes, registerShopRoutes } from '../modules/shops/routes.js';
import { CatalogService } from '../modules/catalog/index.js';
import { registerCatalogRoutes } from '../modules/catalog/routes.js';
import { IntakeService } from '../modules/intake/index.js';
import { registerIntakeRoutes } from '../modules/intake/routes.js';
import { OrdersService } from '../modules/orders/index.js';
import { registerOrdersRoutes } from '../modules/orders/routes.js';
import { registerHealthRoutes } from '../modules/health/routes.js';
import { WebService } from '../modules/web/index.js';
import { registerWebRoutes } from './web-routes.js';
import { registerDocsRoutes } from './docs-routes.js';
import type { Pool } from 'pg';
import { toNodeHandler, trustedOriginsFor, type Auth } from '../platform/auth/better-auth.js';
import { AuthPortalService } from '../modules/portal/service.js';
import { registerPortalRoutes } from './portal-routes.js';
import { EmailService } from '../modules/email/index.js';
import type { InboundWebhookVerifier } from '../modules/email/resend-webhook.js';
import { registerResendWebhook } from './resend-webhook.js';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  auth: AuthService;
  shops: ShopsService;
  catalog: CatalogService;
  intake: IntakeService;
  orders: OrdersService;
  /** Optional public web form (005); mounted only when provided (needs WEB_FORM_SIGNING_KEY). */
  web?: WebService;
  /** Optional inbound email (006/D21); the webhook mounts only when both email + verifier are provided. */
  email?: EmailService;
  /** Optional Resend webhook signature verifier (006/D21); needs RESEND_WEBHOOK_SECRET. */
  emailVerifier?: InboundWebhookVerifier;
  /** Optional Better Auth instance (010); when provided, its routes mount at /api/auth before JSON. */
  betterAuth?: Auth;
  /** Better Auth's migrator Pool (010); the portal service uses it for identity reads during bootstrap
   *  reconciliation. The portal mounts only when BOTH betterAuth and authPool are provided. */
  authPool?: Pool;
}

/** Compose the HTTP app. Health is public; /admin requires an admin credential; /v1 a shop one. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  // Helmet's default Referrer-Policy is `no-referrer`, which makes browsers send `Origin: null` on ordinary
  // same-origin form POSTs (MDN) — that was the browser-login 403. Use a referrer policy that preserves a
  // real Origin for same-origin requests while still protecting cross-origin referrers (D20.3).
  app.use(helmet({ referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));

  // Better Auth (010): mount its handler on the Express 5 catch-all BEFORE any body parser (per its
  // docs — it reads the raw request). Session-guarded portal routes are added further down.
  if (deps.betterAuth) {
    app.all('/api/auth/{*any}', toNodeHandler(deps.betterAuth));
  }

  // Capture the raw body so the email webhook can verify its HMAC signature over exact bytes (006).
  app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(pinoHttp({ logger: deps.logger }));
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  const health = createRouter();
  registerHealthRoutes(health, { db: deps.db, schemaUrl: deps.config.DATABASE_ADMIN_URL });
  app.use(health);

  // OpenAPI + Swagger UI (009) — non-production only (or DOCS_ENABLED), never public in prod.
  if (deps.config.NODE_ENV !== 'production' || deps.config.DOCS_ENABLED) {
    registerDocsRoutes(app);
  }

  // Staff/admin PORTAL (010) — server-rendered, Better Auth sessions. Mounted BEFORE the 009 admin
  // API router so its browser pages (/admin/login, /admin, /admin/staff, /admin/init, /staff/*) take
  // precedence; any unmatched /admin/* (e.g. the 009 JSON API POST /admin/shops) falls through below.
  if (deps.betterAuth && deps.authPool) {
    registerPortalRoutes(app, {
      auth: deps.betterAuth,
      portal: new AuthPortalService(deps.db, deps.betterAuth, deps.authPool),
      orders: deps.orders,
      shops: deps.shops,
      db: deps.db,
      bootstrapToken: deps.config.ADMIN_BOOTSTRAP_TOKEN,
      trustedOrigins: trustedOriginsFor(deps.config.BETTER_AUTH_URL, deps.config.NODE_ENV === 'production'),
      secureCookies: deps.config.NODE_ENV === 'production',
    });
  }

  const admin = createRouter();
  admin.use(adminAuth(deps.auth));
  registerAdminShopRoutes(admin, { shops: deps.shops, auth: deps.auth });
  registerAdminCredentialRoutes(admin, { auth: deps.auth });
  app.use('/admin', admin);

  const v1 = createRouter();
  v1.use(shopAuth(deps.auth));
  registerShopRoutes(v1, { shops: deps.shops });
  registerCatalogRoutes(v1, { catalog: deps.catalog });
  registerIntakeRoutes(v1, { intake: deps.intake });
  registerOrdersRoutes(v1, { orders: deps.orders });
  app.use('/v1', v1);

  // Public web form (005), OUTSIDE shop auth — identity comes from a signed token. Off unless configured.
  if (deps.web) {
    const origins = (deps.config.WEB_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    registerWebRoutes(app, { web: deps.web, allowedOrigins: origins });
  }

  // Inbound Resend webhook (006/D21), OUTSIDE shop auth — authenticated by the Svix signature. Off
  // unless both the EmailService and a verifier (RESEND_WEBHOOK_SECRET) are configured.
  if (deps.email && deps.emailVerifier) {
    registerResendWebhook(app, { email: deps.email, verifier: deps.emailVerifier });
  }

  app.use(errorHandler(deps.logger));
  return app;
}
