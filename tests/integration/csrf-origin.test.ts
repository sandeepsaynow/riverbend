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
// The portal CSRF guard returns 403 for a foreign Origin, and lets a trusted/absent Origin through to the
// handler (which then 401s on bad login creds). So: 403 = CSRF-blocked; 401 = passed CSRF, auth-failed.
const login = (origin?: string, referer?: string) => {
  let r = request(app).post('/admin/login').type('form').send({ email: 'x@y.com', password: 'wrong-password-xx' });
  if (origin !== undefined) r = r.set('Origin', origin);
  if (referer !== undefined) r = r.set('Referer', referer);
  return r;
};

beforeAll(async () => {
  t = await startTestDb();
  authPool = new pg.Pool({ connectionString: t.migratorUrl });
  auth = createAuth({ pool: authPool, secret: 'csrf-secret-0123456789abcdef', baseURL: 'http://localhost:8080', trustedOrigins: trustedOriginsFor('http://localhost:8080', false), secureCookies: false });
  // NODE_ENV omitted → non-production → dev allowlist includes localhost + 127.0.0.1 at :8080.
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test', ADMIN_BOOTSTRAP_TOKEN: 'tok', BETTER_AUTH_URL: 'http://localhost:8080' } as unknown as Config;
  await new CatalogService(t.db).seedFromFile(new URL('../../catalog/catalog.json', import.meta.url).pathname);
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db), shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db), betterAuth: auth, authPool });
}, 180_000);
afterAll(async () => { if (authPool) await authPool.end(); if (t) await stopTestDb(t); });

describe('010/D20.2 — CSRF / full-origin validation', () => {
  it('trustedOriginsFor: prod is a single strict HTTPS origin; dev adds the loopback sibling', () => {
    expect(trustedOriginsFor('https://portal.riverbend.example', true)).toEqual(['https://portal.riverbend.example:443']);
    expect(new Set(trustedOriginsFor('http://localhost:8080', false))).toEqual(new Set(['http://localhost:8080', 'http://127.0.0.1:8080']));
    expect(normalizeOrigin('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeOrigin('http://localhost:8080/admin')).toBe('http://localhost:8080'); // path ignored
    expect(normalizeOrigin('garbage')).toBeNull();
  });

  it('a valid same-origin request passes CSRF (reaches auth → 401, not 403)', async () => {
    expect((await login('http://localhost:8080')).status).toBe(401);
  });

  it('a legitimate 127.0.0.1 browser login is allowed in dev (the reported bug)', async () => {
    expect((await login('http://127.0.0.1:8080')).status).toBe(401); // allowed through CSRF, not 403
  });

  it('a foreign Origin is blocked (403)', async () => {
    expect((await login('https://evil.example')).status).toBe(403);
  });

  it('a different scheme is blocked (https vs the http allowlist)', async () => {
    expect((await login('https://localhost:8080')).status).toBe(403);
  });

  it('a different port is blocked', async () => {
    expect((await login('http://localhost:9999')).status).toBe(403);
  });

  it('a missing Origin is allowed (same-origin form; SameSite cookies are the backstop)', async () => {
    expect((await login(undefined)).status).toBe(401);
  });

  it('a null Origin is blocked (unparseable → not in the allowlist)', async () => {
    expect((await login('null')).status).toBe(403);
  });

  it('an untrusted Referer (when Origin is absent) is blocked', async () => {
    expect((await login(undefined, 'https://evil.example/login')).status).toBe(403);
  });

  it('a trusted Referer (when Origin is absent) is allowed', async () => {
    expect((await login(undefined, 'http://localhost:8080/admin/login')).status).toBe(401);
  });
});
