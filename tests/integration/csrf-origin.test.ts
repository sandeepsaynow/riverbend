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
import { createAuth, type Auth, trustedOriginsFor, normalizeOrigin } from '../../src/platform/auth/better-auth.js';
import type { Config } from '../../src/platform/config/index.js';

let t: TestDb; let app: Express; let authPool: pg.Pool; let auth: Auth;
const setCookies = (res: request.Response): string[] => ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);
const parseCsrf = (html: string): string => (/name="_csrf" value="([^"]+)"/.exec(html)?.[1]) ?? '';

// A browser POST to /admin/login. The portal CSRF guard 403s a bad request; a passing request reaches auth
// and 401s on the (deliberately wrong) credentials. So 403 = CSRF-blocked, 401 = passed CSRF.
async function token(): Promise<{ cookie: string[]; csrf: string }> {
  const g = await request(app).get('/admin/login');
  return { cookie: setCookies(g).filter((c) => c.startsWith('rb_csrf=')), csrf: parseCsrf(g.text) };
}
function login(opts: { origin?: string; referer?: string; cookie?: string[]; csrf?: string }): request.Test {
  let r = request(app).post('/admin/login').type('form');
  if (opts.origin !== undefined) r = r.set('Origin', opts.origin);
  if (opts.referer !== undefined) r = r.set('Referer', opts.referer);
  if (opts.cookie) r = r.set('Cookie', opts.cookie);
  return r.send({ email: 'x@y.com', password: 'wrong-password-xx', ...(opts.csrf !== undefined ? { _csrf: opts.csrf } : {}) });
}

beforeAll(async () => {
  t = await startTestDb();
  authPool = new pg.Pool({ connectionString: t.migratorUrl });
  auth = createAuth({ pool: authPool, secret: 'csrf-secret-0123456789abcdef', baseURL: 'http://localhost:8080', trustedOrigins: trustedOriginsFor('http://localhost:8080', false), secureCookies: false });
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test', ADMIN_BOOTSTRAP_TOKEN: 'tok', BETTER_AUTH_URL: 'http://localhost:8080' } as unknown as Config;
  await new CatalogService(t.db).seedFromFile(new URL('../../catalog/catalog.json', import.meta.url).pathname);
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db), shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db), betterAuth: auth, authPool });
}, 180_000);
afterAll(async () => { if (authPool) await authPool.end(); if (t) await stopTestDb(t); });

describe('010/D20.3 — origin + double-submit CSRF', () => {
  it('trustedOriginsFor/normalizeOrigin: prod is strict HTTPS; dev adds the loopback sibling; path ignored', () => {
    expect(trustedOriginsFor('https://portal.riverbend.example', true)).toEqual(['https://portal.riverbend.example:443']);
    expect(new Set(trustedOriginsFor('http://localhost:8080', false))).toEqual(new Set(['http://localhost:8080', 'http://127.0.0.1:8080']));
    expect(normalizeOrigin('http://localhost:8080/admin')).toBe('http://localhost:8080');
    expect(normalizeOrigin('null')).toBeNull();
    expect(normalizeOrigin('garbage')).toBeNull();
  });

  it('GET /admin/login sets a strict-origin-when-cross-origin Referrer-Policy + an rb_csrf cookie', async () => {
    const g = await request(app).get('/admin/login');
    expect(g.headers['referrer-policy']).toBe('strict-origin-when-cross-origin'); // not Helmet's default no-referrer
    expect(setCookies(g).some((c) => /^rb_csrf=/.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
    expect(parseCsrf(g.text).length).toBeGreaterThan(20); // a real token embedded in the form
  });

  // --- with a valid double-submit token, the ORIGIN layer is what decides ---
  it('valid same-origin (localhost) + valid token → passes CSRF (401 auth, not 403)', async () => {
    const { cookie, csrf } = await token();
    expect((await login({ origin: 'http://localhost:8080', cookie, csrf })).status).toBe(401);
  });
  it('legitimate 127.0.0.1 browser + valid token → allowed in dev (the reported bug)', async () => {
    const { cookie, csrf } = await token();
    expect((await login({ origin: 'http://127.0.0.1:8080', cookie, csrf })).status).toBe(401);
  });
  it('REGRESSION — the exact browser-403: Origin: null + valid token → ALLOWED (401), not 403', async () => {
    const { cookie, csrf } = await token();
    expect((await login({ origin: 'null', cookie, csrf })).status).toBe(401);
  });
  it('foreign Origin is blocked even WITH a valid token (defense-in-depth)', async () => {
    const { cookie, csrf } = await token();
    expect((await login({ origin: 'https://evil.example', cookie, csrf })).status).toBe(403);
  });
  it('different scheme / different port are blocked', async () => {
    const a = await token(); expect((await login({ origin: 'https://localhost:8080', cookie: a.cookie, csrf: a.csrf })).status).toBe(403);
    const b = await token(); expect((await login({ origin: 'http://localhost:9999', cookie: b.cookie, csrf: b.csrf })).status).toBe(403);
  });

  // --- the TOKEN layer: without a valid double-submit pair, even a trusted/absent origin is rejected ---
  it('Origin: null WITHOUT a token is rejected (we never globally allow null)', async () => {
    expect((await login({ origin: 'null' })).status).toBe(403);
  });
  it('missing token (cookie present, no _csrf field) → 403', async () => {
    const { cookie } = await token();
    expect((await login({ origin: 'http://localhost:8080', cookie })).status).toBe(403);
  });
  it('mismatched token (field ≠ cookie) → 403', async () => {
    const { cookie } = await token();
    expect((await login({ origin: 'http://localhost:8080', cookie, csrf: 'not-the-cookie-value' })).status).toBe(403);
  });
  it('missing rb_csrf cookie (field present, no cookie) → 403', async () => {
    const { csrf } = await token();
    expect((await login({ origin: 'http://localhost:8080', csrf })).status).toBe(403);
  });
  it('missing Origin with an untrusted Referer → 403', async () => {
    const { cookie, csrf } = await token();
    expect((await login({ referer: 'https://evil.example/login', cookie, csrf })).status).toBe(403);
  });
  it('missing Origin with a trusted Referer + valid token → allowed (401)', async () => {
    const { cookie, csrf } = await token();
    expect((await login({ referer: 'http://localhost:8080/admin/login', cookie, csrf })).status).toBe(401);
  });
});
