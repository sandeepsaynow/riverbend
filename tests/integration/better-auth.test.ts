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

let t: TestDb;
let app: Express;
let auth: Auth;
let authPool: pg.Pool;

beforeAll(async () => {
  t = await startTestDb();
  authPool = new pg.Pool({ connectionString: t.migratorUrl }); // owner Pool for Better Auth's global tables
  auth = createAuth({ pool: authPool, secret: 'test-better-auth-secret-0123456789', baseURL: 'http://localhost:8080', trustedOrigins: ['http://localhost:8080'], secureCookies: false });
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as unknown as Config;
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db), shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db), betterAuth: auth });
}, 180_000);

afterAll(async () => { if (authPool) await authPool.end(); if (t) await stopTestDb(t); });

describe('010 Slice A — Better Auth over real PostgreSQL', () => {
  it('public signup is disabled', async () => {
    const res = await request(app).post('/api/auth/sign-up/email').send({ email: 'nobody@example.com', password: 'longenoughpassword', name: 'Nope' });
    expect(res.status).toBeGreaterThanOrEqual(400); // disableSignUp → rejected
  });

  it('an admin-created user can sign in; password is stored hashed, wrong password fails', async () => {
    const email = 'staff1@example.com';
    const password = 'Str0ng-Passw0rd-123';
    await auth.api.createUser({ body: { email, password, name: 'Staff One', role: 'user' } });

    const ok = await request(app).post('/api/auth/sign-in/email').send({ email, password });
    expect(ok.status).toBe(200);
    expect(([] as string[]).concat(ok.headers['set-cookie'] ?? []).join(';')).toMatch(/better-auth|session/i); // session cookie set

    const bad = await request(app).post('/api/auth/sign-in/email').send({ email, password: 'wrong-password-xx' });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const acct = await authPool.query<{ password: string | null }>(`SELECT password FROM "account" WHERE "providerId"='credential' AND "userId" IN (SELECT id FROM "user" WHERE email=$1)`, [email]);
    const stored = acct.rows[0]?.password ?? '';
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(password); // never plaintext
  });

  it('a valid session is readable via getSession and rejected when absent', async () => {
    const email = 'staff2@example.com';
    const password = 'An0ther-Str0ng-Pw-456';
    await auth.api.createUser({ body: { email, password, name: 'Staff Two', role: 'user' } });
    const login = await request(app).post('/api/auth/sign-in/email').send({ email, password });
    const cookie = (login.headers['set-cookie'] ?? []) as unknown as string[];
    const me = await request(app).get('/api/auth/get-session').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body?.user?.email).toBe(email);
    const anon = await request(app).get('/api/auth/get-session');
    expect(anon.body?.user ?? null).toBeNull();
  });
});
