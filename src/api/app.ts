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
import { toNodeHandler, type Auth } from '../platform/auth/better-auth.js';
import { EmailService } from '../modules/email/index.js';
import { registerEmailWebhook } from './email-webhook.js';

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
  /** Optional inbound email webhook (006); mounted only when provided + EMAIL_WEBHOOK_SECRET set. */
  email?: EmailService;
  /** Optional Better Auth instance (010); when provided, its routes mount at /api/auth before JSON. */
  betterAuth?: Auth;
}

/** Compose the HTTP app. Health is public; /admin requires an admin credential; /v1 a shop one. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(helmet());

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

  // Inbound email webhook (006), OUTSIDE shop auth — authenticated by HMAC signature. Off unless configured.
  if (deps.email && deps.config.EMAIL_WEBHOOK_SECRET) {
    registerEmailWebhook(app, { email: deps.email, webhookSecret: deps.config.EMAIL_WEBHOOK_SECRET });
  }

  app.use(errorHandler(deps.logger));
  return app;
}
