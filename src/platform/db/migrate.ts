import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { runner as migrationRunner } from 'node-pg-migrate';

const { Client } = pg;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATIONS_TABLE = 'pgmigrations';

/** Apply all pending migrations as the owner/migrator role (migrate-before-serve, FR-022). */
export async function runMigrations(migratorUrl: string): Promise<void> {
  await migrationRunner({
    databaseUrl: migratorUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction: 'up',
    count: Infinity,
    checkOrder: true,
    log: () => {},
  });
}

/** Names of migrations this build ships (filename without extension), in order. */
export function expectedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /\.(c?js|mjs|ts)$/.test(f))
    .map((f) => f.replace(/\.(c?js|mjs|ts)$/, ''))
    .sort();
}

export interface SchemaState {
  pending: string[]; // required by this build but not applied -> migrations_pending
  unknown: string[]; // applied in the DB but unknown to this build -> schema_incompatible
}

/**
 * Compare the migrations this build requires against those recorded in the database.
 * Used by readiness (FR-013): `pending` => migrations_pending, `unknown` => schema_incompatible.
 */
export async function schemaState(databaseUrl: string): Promise<SchemaState> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expected = new Set(expectedMigrations());
    const applied = new Set<string>();
    const reg = await client.query<{ to_regclass: string | null }>(
      `SELECT to_regclass($1) AS to_regclass`,
      [MIGRATIONS_TABLE],
    );
    if (reg.rows[0]?.to_regclass) {
      const res = await client.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
      for (const r of res.rows) applied.add(r.name.replace(/\.(c?js|mjs|ts)$/, ''));
    }
    const pending = [...expected].filter((m) => !applied.has(m)).sort();
    const unknown = [...applied].filter((m) => !expected.has(m)).sort();
    return { pending, unknown };
  } finally {
    await client.end();
  }
}
