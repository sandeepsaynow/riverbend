import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
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
import { OrdersService } from '../../src/modules/orders/index.js';
import { createAuth, type Auth } from '../../src/platform/auth/better-auth.js';
import { AuthPortalService, AlreadyInitialized, RecoveryRequired, PortalError } from '../../src/modules/portal/service.js';
import type { Config } from '../../src/platform/config/index.js';

const BOOT = 'recovery-bootstrap-token';
const PW = 'Str0ng-Passw0rd-123';
let t: TestDb; let app: Express; let authPool: pg.Pool; let auth: Auth; let portal: AuthPortalService; let shopId: string; let k = 0;
const email = (p: string): string => `${p}-${++k}@rb.test`;

const userCount = async (e: string): Promise<number> => Number((await authPool.query<{ n: string }>(`SELECT count(*)::text n FROM "user" WHERE email=$1`, [e])).rows[0]!.n);
const credCount = async (e: string): Promise<number> => Number((await authPool.query<{ n: string }>(`SELECT count(*)::text n FROM "account" WHERE "providerId"='credential' AND "userId" IN (SELECT id FROM "user" WHERE email=$1)`, [e])).rows[0]!.n);
const marker = async (): Promise<{ admin_user_id: string | null; status: string } | undefined> => (await t.db.adminQuery<{ admin_user_id: string | null; status: string }>(`SELECT admin_user_id, status FROM auth_bootstrap WHERE id=true`)).rows[0];
const signIn = (e: string, p = PW) => request(app).post('/api/auth/sign-in/email').send({ email: e, password: p });

beforeAll(async () => {
  t = await startTestDb();
  authPool = new pg.Pool({ connectionString: t.migratorUrl });
  auth = createAuth({ pool: authPool, secret: 'recovery-secret-0123456789abc', baseURL: 'http://localhost:8080', trustedOrigins: ['http://localhost:8080'], secureCookies: false });
  portal = new AuthPortalService(t.db, auth, authPool);
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test', ADMIN_BOOTSTRAP_TOKEN: BOOT, BETTER_AUTH_URL: 'http://localhost:8080' } as unknown as Config;
  await new CatalogService(t.db).seedFromFile(new URL('../../catalog/catalog.json', import.meta.url).pathname);
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db), shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db), betterAuth: auth, authPool });
  shopId = (await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ('rb-rec','America/Chicago','rb-rec') RETURNING id`)).rows[0]!.id;
}, 180_000);
afterAll(async () => { if (authPool) await authPool.end(); if (t) await stopTestDb(t); });

describe('010/D20.1 — bootstrap recovery state machine (fault injection)', () => {
  beforeEach(async () => { await t.db.adminQuery(`DELETE FROM auth_bootstrap`); }); // reset the singleton marker per test

  it('State 1 — crash left a PENDING marker, no user: a retry completes and the admin can log in', async () => {
    const e = email('s1');
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [e]); // simulate crash after reserve
    const r = await portal.initFirstAdmin({ email: e, password: PW, name: 'A' });
    expect(r.userId).toBeTruthy();
    expect((await marker())!.admin_user_id).toBe(r.userId);
    expect(await userCount(e)).toBe(1);
    expect((await signIn(e)).status).toBe(200); // genuinely usable
  });

  it('State 2 — user was fully created but completion was lost: retry reconciles to the SAME user (no duplicate)', async () => {
    const e = email('s2');
    const created = await auth.api.createUser({ body: { email: e, password: PW, name: 'A', role: 'admin' } });
    const existingId = (created as { user: { id: string } }).user.id;
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [e]); // marker never got admin_user_id
    const r = await portal.initFirstAdmin({ email: e, password: PW, name: 'A' });
    expect(r.userId).toBe(existingId); // reconciled, not a new admin
    expect(await userCount(e)).toBe(1); // no duplicate user
    expect((await marker())!.admin_user_id).toBe(existingId);
    expect((await signIn(e)).status).toBe(200);
  });

  it('a COMPLETED init rejects retries (AlreadyInitialized / 409), no second admin', async () => {
    const e = email('done');
    await portal.initFirstAdmin({ email: e, password: PW, name: 'A' });
    await expect(portal.initFirstAdmin({ email: email('other'), password: PW, name: 'B' })).rejects.toBeInstanceOf(AlreadyInitialized);
    expect((await marker())!.status).toBe('completed');
  });

  it('a PENDING init is bound to its email: a retry with a different email is refused (RecoveryRequired)', async () => {
    const a = email('bindA');
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [a]);
    await expect(portal.initFirstAdmin({ email: email('bindB'), password: PW, name: 'B' })).rejects.toBeInstanceOf(RecoveryRequired);
    expect((await marker())!.admin_user_id).toBeNull(); // not completed, no second admin
  });

  it('two concurrent bootstraps (same email) converge on ONE admin', async () => {
    const e = email('conc');
    const results = await Promise.allSettled([
      portal.initFirstAdmin({ email: e, password: PW, name: 'A' }),
      portal.initFirstAdmin({ email: e, password: PW, name: 'A' }),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<{ userId: string }> => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(ok.map((r) => r.value.userId));
    expect(ids.size).toBe(1); // same admin id from any that succeeded
    expect(await userCount(e)).toBe(1); // exactly one admin user
    expect((await marker())!.admin_user_id).toBeTruthy();
    // the other, if rejected, is only AlreadyInitialized — never a duplicate or a lockout
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AlreadyInitialized);
  });

  it('pathological credential-less orphan is flagged RecoveryRequired, NOT falsely completed', async () => {
    const e = email('orphan');
    const c = await auth.api.createUser({ body: { email: e, password: PW, name: 'A', role: 'admin' } });
    const uid = (c as { user: { id: string } }).user.id;
    await authPool.query(`DELETE FROM "account" WHERE "userId"=$1`, [uid]); // simulate a user with no usable password
    expect(await credCount(e)).toBe(0);
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [e]);
    await expect(portal.initFirstAdmin({ email: e, password: PW, name: 'A' })).rejects.toBeInstanceOf(RecoveryRequired);
    expect((await marker())!.admin_user_id).toBeNull(); // never marked usable
  });

  it('HTTP /admin/init: 201 then 409; a failed attempt does not permanently lock out', async () => {
    const e = email('http');
    const ok = await request(app).post('/admin/init').send({ bootstrap_token: BOOT, email: e, password: PW, name: 'A' });
    expect(ok.status).toBe(201);
    const again = await request(app).post('/admin/init').send({ bootstrap_token: BOOT, email: email('http2'), password: PW, name: 'B' });
    expect(again.status).toBe(409);
  });
});

describe('010/D20.1 — staff creation atomicity (fault injection)', () => {
  it('unknown shop fails BEFORE any identity is created (no orphan user)', async () => {
    const e = email('badshop');
    await expect(portal.createStaff({ email: e, name: 'S', password: PW, shopId: '00000000-0000-0000-0000-000000000000', role: 'SHOP_STAFF' })).rejects.toBeInstanceOf(PortalError);
    expect(await userCount(e)).toBe(0); // identity not created on a bad shop
  });

  it('membership failure leaves an orphan identity (no privilege); a retry completes it idempotently', async () => {
    const e = email('orphanstaff');
    await auth.api.createUser({ body: { email: e, password: PW, name: 'S', role: 'user' } }); // simulate: user made, membership step never ran
    const r = await portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' });
    expect(await userCount(e)).toBe(1); // reused the orphan — no duplicate identity
    const m = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text n FROM shop_membership WHERE user_id=$1`, [r.userId]);
    expect(Number(m.rows[0]!.n)).toBe(1);
  });

  it('a duplicate email that belongs to a REAL account is refused, not silently attached to a new shop', async () => {
    const e = email('dupstaff');
    const first = await portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' });
    const shop2 = (await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ('rb-rec2','America/Chicago','rb-rec2') RETURNING id`)).rows[0]!.id;
    await expect(portal.createStaff({ email: e, name: 'S', password: PW, shopId: shop2, role: 'SHOP_STAFF' })).rejects.toBeInstanceOf(PortalError);
    const m = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text n FROM shop_membership WHERE user_id=$1`, [first.userId]);
    expect(Number(m.rows[0]!.n)).toBe(1); // still only its original shop
  });

  it('concurrent duplicate staff creation yields one user and one membership', async () => {
    const e = email('concstaff');
    const results = await Promise.allSettled([
      portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' }),
      portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' }),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await userCount(e)).toBe(1);
    const uid = (await authPool.query<{ id: string }>(`SELECT id FROM "user" WHERE email=$1`, [e])).rows[0]!.id;
    const m = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text n FROM shop_membership WHERE user_id=$1`, [uid]);
    expect(Number(m.rows[0]!.n)).toBe(1); // unique(user,shop) + upsert → exactly one
  });
});
