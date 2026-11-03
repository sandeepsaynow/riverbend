import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { checkReadiness } from '../../src/modules/health/readiness.js';
import { schemaState } from '../../src/platform/db/migrate.js';
import { Db } from '../../src/platform/db/index.js';
import { AuthService } from '../../src/modules/auth/index.js';

let t: TestDb;

beforeAll(async () => {
  t = await startTestDb();
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

describe('readiness (FR-013) — three checks, config excluded', () => {
  it('is ready on a migrated, policed database', async () => {
    const res = await checkReadiness(t.db, t.adminUrl);
    expect(res).toEqual({ ready: true, reasons: [] });
  });

  it('reports db_unreachable when the store cannot be reached', async () => {
    const dead = new Db({
      appUrl: 'postgres://app_user:app_pw@127.0.0.1:1/none',
      adminUrl: 'postgres://app_admin:admin_pw@127.0.0.1:1/none',
    });
    const res = await checkReadiness(dead, 'postgres://x:y@127.0.0.1:1/none');
    expect(res.ready).toBe(false);
    expect(res.reasons).toContain('db_unreachable');
    await dead.close();
  });

  it('reports migrations_pending when a required migration is not applied', async () => {
    const su = new pg.Client({ connectionString: t.migratorUrl });
    await su.connect();
    await su.query(`DELETE FROM pgmigrations WHERE name LIKE '2000_catalog%'`);
    try {
      const state = await schemaState(t.adminUrl);
      expect(state.pending).toContain('2000_catalog');
      const res = await checkReadiness(t.db, t.adminUrl);
      expect(res.ready).toBe(false);
      expect(res.reasons).toContain('migrations_pending');
    } finally {
      await su.query(`INSERT INTO pgmigrations (name, run_on) VALUES ('2000_catalog', now())`);
      await su.end();
    }
  });

  it('reports schema_incompatible when an unknown/newer migration is applied', async () => {
    const su = new pg.Client({ connectionString: t.migratorUrl });
    await su.connect();
    await su.query(`INSERT INTO pgmigrations (name, run_on) VALUES ('9999_future', now())`);
    try {
      const state = await schemaState(t.adminUrl);
      expect(state.unknown).toContain('9999_future');
      const res = await checkReadiness(t.db, t.adminUrl);
      expect(res.reasons).toContain('schema_incompatible');
    } finally {
      await su.query(`DELETE FROM pgmigrations WHERE name = '9999_future'`);
      await su.end();
    }
  });

  it('reports security_policy_missing when a tenant table is not force-RLS', async () => {
    const su = new pg.Client({ connectionString: t.migratorUrl });
    await su.connect();
    await su.query(`ALTER TABLE credentials NO FORCE ROW LEVEL SECURITY`);
    try {
      const res = await checkReadiness(t.db, t.adminUrl);
      expect(res.ready).toBe(false);
      expect(res.reasons).toContain('security_policy_missing');
    } finally {
      await su.query(`ALTER TABLE credentials FORCE ROW LEVEL SECURITY`);
      await su.end();
    }
  });
});

describe('bootstrap admin — fail closed (FR-021)', () => {
  it('refuses an empty bootstrap token', async () => {
    const auth = new AuthService(t.db);
    await expect(auth.ensureBootstrapAdmin('')).rejects.toThrow();
  });

  it('rejects invalid or malformed credentials after bootstrap', async () => {
    const auth = new AuthService(t.db);
    await auth.ensureBootstrapAdmin('the-real-secret');
    expect(await auth.authenticate('rb_admin_bootstrap.the-real-secret')).not.toBeNull();
    expect(await auth.authenticate('rb_admin_bootstrap.wrong')).toBeNull();
    expect(await auth.authenticate('not-a-token')).toBeNull();
  });
});
