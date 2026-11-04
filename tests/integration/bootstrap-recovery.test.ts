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

const userRow = async (e: string): Promise<{ id: string; role: string | null } | undefined> => (await authPool.query<{ id: string; role: string | null }>(`SELECT id, role FROM "user" WHERE email=$1`, [e])).rows[0];
const userCount = async (e: string): Promise<number> => Number((await authPool.query<{ n: string }>(`SELECT count(*)::text n FROM "user" WHERE email=$1`, [e])).rows[0]!.n);
const marker = async (): Promise<{ admin_user_id: string | null; status: string } | undefined> => (await t.db.adminQuery<{ admin_user_id: string | null; status: string }>(`SELECT admin_user_id, status FROM auth_bootstrap WHERE id=true`)).rows[0];
const membershipCount = async (uid: string): Promise<number> => Number((await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text n FROM shop_membership WHERE user_id=$1`, [uid])).rows[0]!.n);
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

describe('010/D20.2 — ownership-proven bootstrap recovery (fault injection)', () => {
  beforeEach(async () => { await t.db.adminQuery(`DELETE FROM auth_bootstrap`); }); // reset the singleton marker per test

  it('State 1 — PENDING marker, no user: a retry creates, records, completes, and the admin logs in', async () => {
    const e = email('s1');
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [e]);
    const r = await portal.initFirstAdmin({ email: e, password: PW, name: 'A' });
    expect((await marker())!.admin_user_id).toBe(r.userId);
    expect((await marker())!.status).toBe('completed');
    expect((await signIn(e)).status).toBe(200);
  });

  it('RECORDED-but-not-finalized marker (crash after record): a retry finalizes idempotently', async () => {
    const e = email('rec');
    const created = await auth.api.createUser({ body: { email: e, password: PW, name: 'A', role: 'admin' } });
    const uid = (created as { user: { id: string } }).user.id;
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_user_id, admin_email, status) VALUES (true,$1,$2,'pending')`, [uid, e]); // recorded, not completed
    const r = await portal.initFirstAdmin({ email: e, password: PW, name: 'A' });
    expect(r.userId).toBe(uid);
    expect((await marker())!.status).toBe('completed');
  });

  it('SECURITY — a pre-existing account whose email matches is NEVER adopted as admin (fail closed)', async () => {
    const e = email('preexist');
    await auth.api.createUser({ body: { email: e, password: PW, name: 'Human', role: 'user' } }); // unrelated account, NOT a bootstrap
    await expect(portal.initFirstAdmin({ email: e, password: PW, name: 'A' })).rejects.toBeInstanceOf(RecoveryRequired);
    expect((await marker())!.admin_user_id).toBeNull(); // not completed, not adopted
    expect((await userRow(e))!.role).toBe('user'); // the pre-existing account was NOT elevated to admin
  });

  it('a crash after createUser (user not recorded) fails closed to operator recovery, not auto-adoption', async () => {
    const e = email('crash');
    await auth.api.createUser({ body: { email: e, password: PW, name: 'A', role: 'admin' } }); // user exists, marker never recorded it
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [e]);
    await expect(portal.initFirstAdmin({ email: e, password: PW, name: 'A' })).rejects.toBeInstanceOf(RecoveryRequired);
    expect((await marker())!.admin_user_id).toBeNull();
  });

  it('a COMPLETED init rejects retries (AlreadyInitialized); no second admin', async () => {
    const e = email('done');
    await portal.initFirstAdmin({ email: e, password: PW, name: 'A' });
    await expect(portal.initFirstAdmin({ email: email('other'), password: PW, name: 'B' })).rejects.toBeInstanceOf(AlreadyInitialized);
    expect((await marker())!.status).toBe('completed');
  });

  it('a PENDING init is bound to its email: a different-email retry is refused (RecoveryRequired)', async () => {
    const a = email('bindA');
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true,$1,'pending')`, [a]);
    await expect(portal.initFirstAdmin({ email: email('bindB'), password: PW, name: 'B' })).rejects.toBeInstanceOf(RecoveryRequired);
    expect((await marker())!.admin_user_id).toBeNull();
  });

  it('two concurrent bootstraps (same email) converge on ONE admin, no duplicate, no false RecoveryRequired', async () => {
    const e = email('conc');
    const results = await Promise.allSettled([
      portal.initFirstAdmin({ email: e, password: PW, name: 'A' }),
      portal.initFirstAdmin({ email: e, password: PW, name: 'A' }),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<{ userId: string }> => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.userId)).size).toBe(1);
    expect(await userCount(e)).toBe(1);
    expect((await marker())!.admin_user_id).toBeTruthy();
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AlreadyInitialized);
  });

  it('a recorded admin with NO credential is flagged RecoveryRequired, not completed', async () => {
    const e = email('nocred');
    const c = await auth.api.createUser({ body: { email: e, password: PW, name: 'A', role: 'admin' } });
    const uid = (c as { user: { id: string } }).user.id;
    await authPool.query(`DELETE FROM "account" WHERE "userId"=$1`, [uid]);
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (id, admin_user_id, admin_email, status) VALUES (true,$1,$2,'pending')`, [uid, e]);
    await expect(portal.initFirstAdmin({ email: e, password: PW, name: 'A' })).rejects.toBeInstanceOf(RecoveryRequired);
    expect((await marker())!.status).toBe('pending');
  });

  it('HTTP /admin/init: 201 then 409; a failed attempt never permanently locks out', async () => {
    const e = email('http');
    expect((await request(app).post('/admin/init').send({ bootstrap_token: BOOT, email: e, password: PW, name: 'A' })).status).toBe(201);
    expect((await request(app).post('/admin/init').send({ bootstrap_token: BOOT, email: email('http2'), password: PW, name: 'B' })).status).toBe(409);
  });
});

describe('010/D20.2 — staff creation never adopts a pre-existing account', () => {
  it('unknown shop fails BEFORE any identity is created (no orphan user)', async () => {
    const e = email('badshop');
    await expect(portal.createStaff({ email: e, name: 'S', password: PW, shopId: '00000000-0000-0000-0000-000000000000', role: 'SHOP_STAFF' })).rejects.toBeInstanceOf(PortalError);
    expect(await userCount(e)).toBe(0);
  });

  it('a duplicate email fails closed — a pre-existing account is NEVER attached a new membership', async () => {
    const e = email('dupstaff');
    const first = await portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' });
    const shop2 = (await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ('rb-rec2','America/Chicago','rb-rec2') RETURNING id`)).rows[0]!.id;
    await expect(portal.createStaff({ email: e, name: 'S', password: PW, shopId: shop2, role: 'SHOP_STAFF' })).rejects.toBeInstanceOf(PortalError);
    expect(await membershipCount(first.userId)).toBe(1); // still only its original shop
  });

  it('SECURITY — createStaff with the platform admin’s email is refused (admin gets no shop membership)', async () => {
    const adminEmail = email('plat-admin');
    await t.db.adminQuery(`DELETE FROM auth_bootstrap`);
    const admin = await portal.initFirstAdmin({ email: adminEmail, password: PW, name: 'Platform Admin' });
    await expect(portal.createStaff({ email: adminEmail, name: 'X', password: PW, shopId, role: 'SHOP_STAFF' })).rejects.toBeInstanceOf(PortalError);
    expect(await membershipCount(admin.userId)).toBe(0); // the platform admin was NOT granted a shop membership
  });

  it('a membership-less orphan from a failed creation stays NON-privileged; a retry fails closed', async () => {
    const e = email('orphanstaff');
    await auth.api.createUser({ body: { email: e, password: PW, name: 'S', role: 'user' } }); // user made, membership never ran
    await expect(portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' })).rejects.toBeInstanceOf(PortalError);
    const uid = (await userRow(e))!.id;
    expect(await membershipCount(uid)).toBe(0); // orphan has NO membership → no access; operator cleanup
  });

  it('concurrent duplicate staff creation: exactly one user, one membership, the other refused', async () => {
    const e = email('concstaff');
    const results = await Promise.allSettled([
      portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' }),
      portal.createStaff({ email: e, name: 'S', password: PW, shopId, role: 'SHOP_STAFF' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(await userCount(e)).toBe(1);
    const uid = (await userRow(e))!.id;
    expect(await membershipCount(uid)).toBe(1);
  });
});
