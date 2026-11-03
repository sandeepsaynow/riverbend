import { loadConfig } from '../config/index.js';
import { runMigrations } from './migrate.js';

// `npm run migrate` — apply migrations as the owner role. Also run automatically at api startup.
async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.DATABASE_MIGRATOR_URL);
  // eslint-disable-next-line no-console
  console.log('Migrations applied.');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
