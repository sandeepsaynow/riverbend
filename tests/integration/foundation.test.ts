import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import type { Express } from 'express';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { createApp } from '../../src/api/app.js';
import { createLogger } from '../../src/platform/observability/logger.js';
import { AuthService } from '../../src/modules/auth/index.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { findPolicyGaps } from '../../src/platform/db/policy-check.js';
import type { Config } from '../../src/platform/config/index.js';

const BOOTSTRAP_SECRET = 'test-admin-secret';
const ADMIN_TOKEN = `rb_admin_bootstrap.${BOOTSTRAP_SECRET}`;
const CATALOG = resolve(process.cwd(), 'catalog/catalog.json');

let t: TestDb;
let app: Express;

async function createShop(slug: string, tz = 'America/Chicago') {
  return request(app).post('/admin/shops').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({ slug, time_zone: tz });
}
async function issueKey(slug: string): Promise<string> {
  const res = await request(app)
    .post(`/admin/shops/${slug}/credentials`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  expect(res.status).toBe(201);
  return res.body.secret as string;
}
async function shopIdOf(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`SELECT id FROM shops WHERE slug = $1`, [slug]);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  t = await startTestDb();
  const auth = new AuthService(t.db);
  await auth.ensureBootstrapAdmin(BOOTSTRAP_SECRET);
  const shops = new ShopsService(t.db);
  const catalog = new CatalogService(t.db);
  await catalog.seedFromFile(CATALOG);
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal' } as unknown as Config;
  const intake = new IntakeService(t.db);
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth, shops, catalog, intake });
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

describe('health (US3) — liveness independent of readiness', () => {
  it('GET /healthz is alive and unauthenticated', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });
  it('GET /readyz is ready once migrated + policed, unauthenticated', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });
});

describe('US2 — provisioning and credentials', () => {
  it('requires an admin credential to create a shop (FR-023)', async () => {
    const noAuth = await request(app).post('/admin/shops').send({ slug: 'rb-x', time_zone: 'UTC' });
    expect(noAuth.status).toBe(401);
  });

  it('creates shops and rejects a duplicate slug (FR-005)', async () => {
    const a = await createShop('rb-downtown');
    expect(a.status).toBe(201);
    expect(a.body.slug).toBe('rb-downtown');
    await createShop('rb-northside');
    const dup = await createShop('rb-downtown');
    expect(dup.status).toBe(409);
  });

  it('rejects an invalid time zone (FR-006)', async () => {
    const res = await createShop('rb-badtz', 'Not/AZone');
    expect(res.status).toBe(422);
  });

  it('issues a credential shown once; two active keys both authenticate; revoke is individual (FR-007/008/009/010)', async () => {
    const k1 = await issueKey('rb-downtown');
    const k2 = await issueKey('rb-downtown');
    expect(k1).not.toEqual(k2);

    const r1 = await request(app).get('/v1/shop').set('Authorization', `Bearer ${k1}`);
    const r2 = await request(app).get('/v1/shop').set('Authorization', `Bearer ${k2}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // last_used_at is updated on authentication.
    const used = await t.db.adminQuery<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM credentials WHERE kind='shop' AND last_used_at IS NOT NULL`,
    );
    expect(used.rows.length).toBeGreaterThanOrEqual(2);

    // Revoke k1 only.
    const idRow = await t.db.adminQuery<{ id: string; prefix: string }>(
      `SELECT id, prefix FROM credentials WHERE kind='shop' ORDER BY created_at`,
    );
    const k1Prefix = k1.split('.')[0]!.replace('rb_shop_', '');
    const k1Id = idRow.rows.find((r) => r.prefix === k1Prefix)!.id;
    const rev = await request(app)
      .post(`/admin/credentials/${k1Id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(rev.status).toBe(204);

    const afterRevoke = await request(app).get('/v1/shop').set('Authorization', `Bearer ${k1}`);
    expect(afterRevoke.status).toBe(401);
    const stillOk = await request(app).get('/v1/shop').set('Authorization', `Bearer ${k2}`);
    expect(stillOk.status).toBe(200);
  });

  it('rejects a shop credential on an admin route and vice-versa (FR-020)', async () => {
    const shopKey = await issueKey('rb-northside');
    const onAdmin = await request(app)
      .post('/admin/shops')
      .set('Authorization', `Bearer ${shopKey}`)
      .send({ slug: 'rb-sneaky', time_zone: 'UTC' });
    expect(onAdmin.status).toBe(403);
    const onShop = await request(app).get('/v1/shop').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(onShop.status).toBe(403);
  });
});

describe('US1 — shop isolation (I1)', () => {
  it('via API: a shop credential only ever sees its own shop (identity from the key, FR-001)', async () => {
    const downtownKey = await issueKey('rb-downtown');
    const northsideKey = await issueKey('rb-northside');
    const d = await request(app).get('/v1/shop').set('Authorization', `Bearer ${downtownKey}`);
    const n = await request(app).get('/v1/shop').set('Authorization', `Bearer ${northsideKey}`);
    expect(d.body.slug).toBe('rb-downtown');
    expect(n.body.slug).toBe('rb-northside');
  });

  it('direct-to-DB as app_user: cannot read/update/delete another shop, even by id', async () => {
    const downtownId = await shopIdOf('rb-downtown');
    const northsideId = await shopIdOf('rb-northside');
    const client = new pg.Client({ connectionString: t.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [downtownId]);

      const visible = await client.query<{ id: string }>(`SELECT id FROM shops`);
      expect(visible.rows.map((r) => r.id)).toEqual([downtownId]);

      const other = await client.query(`SELECT id FROM shops WHERE id = $1`, [northsideId]);
      expect(other.rowCount).toBe(0);

      const upd = await client.query(`UPDATE shops SET display_name = 'hacked' WHERE id = $1`, [northsideId]);
      expect(upd.rowCount).toBe(0);
      const del = await client.query(`DELETE FROM shops WHERE id = $1`, [northsideId]);
      expect(del.rowCount).toBe(0);

      const creds = await client.query(`SELECT shop_id FROM credentials`);
      expect(creds.rows.every((r) => r.shop_id === downtownId)).toBe(true);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    // With NO tenant set, app_user sees nothing (fail-closed).
    const bare = new pg.Client({ connectionString: t.appUrl });
    await bare.connect();
    try {
      const res = await bare.query(`SELECT count(*)::int AS n FROM shops`);
      expect(res.rows[0].n).toBe(0);
    } finally {
      await bare.end();
    }
  });

  it('policy build-check (FR-004): clean now, and catches an unpoliced tenant_id table', async () => {
    expect(await findPolicyGaps(t.db)).toEqual([]);
    const su = new pg.Client({ connectionString: t.migratorUrl });
    await su.connect();
    try {
      await su.query(`CREATE TABLE leaky (id serial PRIMARY KEY, shop_id uuid)`);
      const gaps = await findPolicyGaps(t.db);
      expect(gaps.some((g) => g.table === 'leaky')).toBe(true);
    } finally {
      await su.query(`DROP TABLE IF EXISTS leaky`);
      await su.end();
    }
  });
});

describe('US5 — shared versioned catalog', () => {
  it('serves exactly 12 whole-cent services, identical across shops, with a version (SC-007)', async () => {
    const dKey = await issueKey('rb-downtown');
    const nKey = await issueKey('rb-northside');
    const d = await request(app).get('/v1/catalog').set('Authorization', `Bearer ${dKey}`);
    const n = await request(app).get('/v1/catalog').set('Authorization', `Bearer ${nKey}`);
    expect(d.status).toBe(200);
    expect(d.body.catalog_version).toBe('cat-001');
    expect(d.body.services).toHaveLength(12);
    expect(d.body.services.every((s: { price_cents: number }) => Number.isInteger(s.price_cents))).toBe(true);
    expect(n.body).toEqual(d.body);
  });
});
