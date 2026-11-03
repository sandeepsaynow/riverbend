import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { Db } from '../../src/platform/db/index.js';
import { runMigrations } from '../../src/platform/db/migrate.js';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  migratorUrl: string;
  appUrl: string;
  adminUrl: string;
  db: Db;
}

/**
 * Start a real PostgreSQL (Testcontainers), provision the two runtime roles, and (by default)
 * run migrations. The container's default superuser acts as the migrator. app_user/app_admin are
 * NOBYPASSRLS — exactly the roles the application uses — so RLS is genuinely exercised.
 */
export async function startTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16').start();
  const host = container.getHost();
  const port = container.getPort();
  const database = container.getDatabase();
  const migratorUrl = `postgres://${container.getUsername()}:${container.getPassword()}@${host}:${port}/${database}`;

  const su = new pg.Client({ connectionString: migratorUrl });
  await su.connect();
  await su.query(`CREATE ROLE app_user LOGIN PASSWORD 'app_pw' NOBYPASSRLS`);
  await su.query(`CREATE ROLE app_admin LOGIN PASSWORD 'admin_pw' NOBYPASSRLS`);
  await su.query(`GRANT CONNECT ON DATABASE "${database}" TO app_user, app_admin`);
  await su.query(`GRANT USAGE ON SCHEMA public TO app_user, app_admin`);
  await su.end();

  const appUrl = `postgres://app_user:app_pw@${host}:${port}/${database}`;
  const adminUrl = `postgres://app_admin:admin_pw@${host}:${port}/${database}`;

  if (opts.migrate !== false) await runMigrations(migratorUrl);

  const db = new Db({ appUrl, adminUrl });
  return { container, migratorUrl, appUrl, adminUrl, db };
}

export async function stopTestDb(t: TestDb): Promise<void> {
  await t.db.close();
  await t.container.stop();
}
