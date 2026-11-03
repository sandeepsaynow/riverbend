import { resolve } from 'node:path';
import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';
import { Db } from '../platform/db/index.js';
import { runMigrations, schemaState } from '../platform/db/migrate.js';
import { findPolicyGaps } from '../platform/db/policy-check.js';
import { AuthService } from '../modules/auth/index.js';
import { ShopsService } from '../modules/shops/index.js';
import { CatalogService } from '../modules/catalog/index.js';
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

  // 6. Serve.
  const app = createApp({ config, db, logger, auth, shops, catalog });
  app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
