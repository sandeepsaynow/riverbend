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
import { OrdersService } from '../../src/modules/orders/index.js';
import { createAuth, type Auth } from '../../src/platform/auth/better-auth.js';
import type { Config } from '../../src/platform/config/index.js';

const BOOT = 'portal-bootstrap-token';
let t: TestDb;
let app: Express;
let authPool: pg.Pool;
let intake: IntakeService;
let orders: OrdersService;
let downtown: string;
let northside: string;
let n = 0;

async function shop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
async function seedOrder(shopId: string): Promise<string> {
  const sub = await intake.submit({ shopId, source: 'api', submissionId: `o-${++n}`, content: 'tune' });
  await t.db.adminQuery(`UPDATE requests SET state='extracted' WHERE id=$1`, [sub.requestId]);
  await t.db.adminQuery(`INSERT INTO extractions (shop_id, request_id, kind, bikes, urgency) VALUES ($1,$2,'repair',$3,'normal')`, [shopId, sub.requestId, JSON.stringify([{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }])]);
  await orders.createFromExtraction(shopId, sub.requestId);
  return sub.requestId;
}
const cookies = (res: request.Response): string[] => ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);
const parseCsrf = (html: string): string => (/name="_csrf" value="([^"]+)"/.exec(html)?.[1]) ?? '';
const csrfCookie = (res: request.Response): string[] => cookies(res).filter((c) => c.startsWith('rb_csrf='));
/** CSRF-aware POST: GET `formPage` to obtain the double-submit token + rb_csrf cookie, then POST with both. */
async function csrfPost(path: string, fields: Record<string, string>, sessionCookies: string[], formPage: string): Promise<request.Response> {
  const g = await request(app).get(formPage).set('Cookie', sessionCookies);
  return request(app).post(path).set('Cookie', [...sessionCookies, ...csrfCookie(g)]).type('form').send({ ...fields, _csrf: parseCsrf(g.text) });
}
async function login(path: string, email: string, password: string): Promise<string[]> {
  const g = await request(app).get(path); // issues the rb_csrf cookie + embeds the token
  const res = await request(app).post(path).set('Cookie', csrfCookie(g)).type('form').send({ email, password, _csrf: parseCsrf(g.text) });
  expect(res.status).toBe(302);
  return cookies(res);
}

beforeAll(async () => {
  t = await startTestDb();
  authPool = new pg.Pool({ connectionString: t.migratorUrl });
  const auth: Auth = createAuth({ pool: authPool, secret: 'portal-test-secret-0123456789abc', baseURL: 'http://localhost:8080', trustedOrigins: ['http://localhost:8080'], secureCookies: false });
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test', ADMIN_BOOTSTRAP_TOKEN: BOOT, BETTER_AUTH_URL: 'http://localhost:8080' } as unknown as Config;
  intake = new IntakeService(t.db);
  orders = new OrdersService(t.db);
  await new CatalogService(t.db).seedFromFile(resolve(process.cwd(), 'catalog/catalog.json'));
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db), shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake, orders, betterAuth: auth, authPool });
  downtown = await shop('rb-downtown');
  northside = await shop('rb-northside');
}, 180_000);
afterAll(async () => { if (authPool) await authPool.end(); if (t) await stopTestDb(t); });

describe('010 portal — bootstrap + staff mgmt + shop-scoped console', () => {
  it('first-admin init is single-use (second attempt 409) and bootstrap-token gated', async () => {
    const bad = await request(app).post('/admin/init').send({ email: 'a@x.com', password: 'longenoughpass12', name: 'A' });
    expect(bad.status).toBe(401); // no bootstrap token
    const ok = await request(app).post('/admin/init').send({ bootstrap_token: BOOT, email: 'admin@rb.com', password: 'Admin-Password-123', name: 'Admin' });
    expect(ok.status).toBe(201);
    const again = await request(app).post('/admin/init').send({ bootstrap_token: BOOT, email: 'admin2@rb.com', password: 'Admin-Password-999', name: 'Admin2' });
    expect(again.status).toBe(409); // single-use
  });

  it('admin creates staff; each staff sees ONLY their shop; cross-shop is denied', async () => {
    const dOrder = await seedOrder(downtown);
    const nOrder = await seedOrder(northside);
    const adminCookie = await login('/admin/login', 'admin@rb.com', 'Admin-Password-123');

    const mk1 = await csrfPost('/admin/staff', { email: 'staff1@rb.com', name: 'Staff1', password: 'Staff1-Password-123', shop_id: downtown, role: 'SHOP_STAFF' }, adminCookie, '/admin/staff');
    expect(mk1.status).toBe(302);
    const mk2 = await csrfPost('/admin/staff', { email: 'staff2@rb.com', name: 'Staff2', password: 'Staff2-Password-123', shop_id: northside, role: 'SHOP_STAFF' }, adminCookie, '/admin/staff');
    expect(mk2.status).toBe(302);

    const c1 = await login('/staff/login', 'staff1@rb.com', 'Staff1-Password-123');
    const o1 = await request(app).get('/staff/orders').set('Cookie', c1);
    expect(o1.status).toBe(200);
    expect(o1.text).toContain(dOrder);
    expect(o1.text).not.toContain(nOrder); // cannot see Northside's order

    // Attempt to force another shop via ?shop= — ignored (not an authorized membership).
    const forced = await request(app).get(`/staff/orders?shop=${northside}`).set('Cookie', c1);
    expect(forced.text).not.toContain(nOrder);

    const c2 = await login('/staff/login', 'staff2@rb.com', 'Staff2-Password-123');
    const o2 = await request(app).get('/staff/orders').set('Cookie', c2);
    expect(o2.text).toContain(nOrder);
    expect(o2.text).not.toContain(dOrder);
  });

  it('staff console escapes customer-controlled content and leaks no secrets', async () => {
    // Seed a request whose customer email carries an XSS payload.
    const sub = await intake.submit({ shopId: downtown, source: 'web', submissionId: `xss-${Date.now()}`, content: 'brake check', customerEmail: '<script>alert(1)</script>@x.com' });
    const c1 = await login('/staff/login', 'staff1@rb.com', 'Staff1-Password-123');
    const list = await request(app).get('/staff/requests').set('Cookie', c1);
    expect(list.status).toBe(200);
    expect(list.text).toContain('&lt;script&gt;'); // escaped
    expect(list.text).not.toContain('<script>alert(1)</script>'); // never raw
    const detail = await request(app).get(`/staff/requests/${sub.requestId}`).set('Cookie', c1);
    expect(detail.text).toContain('brake check');
    expect(detail.text).not.toContain('<script>alert(1)</script>');
    const usage = await request(app).get('/staff/usage').set('Cookie', c1);
    expect(usage.status).toBe(200);
    expect(usage.text).not.toMatch(/sk-[A-Za-z0-9]{10,}|password/i); // no secrets rendered
  });

  it('disabling a staff account rejects its session and subsequent login', async () => {
    const adminCookie = await login('/admin/login', 'admin@rb.com', 'Admin-Password-123');
    const c1 = await login('/staff/login', 'staff1@rb.com', 'Staff1-Password-123');
    expect((await request(app).get('/staff').set('Cookie', c1)).status).toBe(200); // works before disable

    const uid = (await t.db.adminQuery<{ user_id: string }>(`SELECT user_id FROM shop_membership WHERE shop_id=$1 LIMIT 1`, [downtown])).rows[0]!.user_id;
    const dis = await csrfPost(`/admin/staff/${uid}/disable`, {}, adminCookie, '/admin/staff');
    expect(dis.status).toBe(302);

    const after = await request(app).get('/staff').set('Cookie', c1); // existing session revoked
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/staff/login');
    const g = await request(app).get('/staff/login');
    const relogin = await request(app).post('/staff/login').set('Cookie', csrfCookie(g)).type('form').send({ email: 'staff1@rb.com', password: 'Staff1-Password-123', _csrf: parseCsrf(g.text) });
    expect(relogin.status).toBe(401); // banned user cannot log in
  });

  it('API-key path (009) is unaffected — Swagger JSON still served', async () => {
    expect((await request(app).get('/openapi.json')).status).toBe(200);
  });
});
