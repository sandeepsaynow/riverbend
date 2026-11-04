import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { createApp } from '../../src/api/app.js';
import { createLogger } from '../../src/platform/observability/logger.js';
import { AuthService } from '../../src/modules/auth/index.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { OrdersService } from '../../src/modules/orders/index.js';
import { WebService } from '../../src/modules/web/index.js';
import { FakeTurnstileVerifier } from '../../src/modules/web/turnstile.js';
import type { Config } from '../../src/platform/config/index.js';

const SIGNING_KEY = 'test-web-signing-key';
let t: TestDb;
let app: Express;

async function createShop(slug: string): Promise<void> {
  await t.db.adminQuery(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1)`, [slug]);
}
function tokenFromPage(html: string): string {
  return /name="form_token" value="([^"]+)"/.exec(html)![1]!;
}
function webCount(): Promise<number> {
  return t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE source='web'`).then((r) => Number(r.rows[0]!.n));
}

beforeAll(async () => {
  t = await startTestDb();
  const auth = new AuthService(t.db);
  const intake = new IntakeService(t.db);
  const web = new WebService(t.db, intake, { signingKey: SIGNING_KEY, turnstile: new FakeTurnstileVerifier() });
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', WEB_ALLOWED_ORIGINS: '' } as unknown as Config;
  app = createApp({
    config, db: t.db, logger: createLogger('fatal'), auth,
    shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake, orders: new OrdersService(t.db), web,
  });
  await createShop('rb-web');
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

async function getToken(): Promise<string> {
  const page = await request(app).get('/f/rb-web');
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toContain("form-action 'self'");
  return tokenFromPage(page.text);
}

describe('005 web form — intake + defences', () => {
  it('serves a per-shop form with a signed token and a strict CSP', async () => {
    const page = await request(app).get('/f/rb-web');
    expect(page.status).toBe(200);
    expect(page.text).toContain('rb-web');
    expect(tokenFromPage(page.text)).toMatch(/\./);
    const unknown = await request(app).get('/f/nope');
    expect(unknown.status).toBe(404);
  });

  it('happy path → 202, refresh-safe idempotency, working status link (US1/FR-003)', async () => {
    const form_token = await getToken();
    const body = { form_token, email: 'rider@example.com', description: 'my chain keeps slipping', submission_id: 'web-uuid-1', website: '', 'cf-turnstile-response': 'ok' };
    const first = await request(app).post('/f/submit').type('form').send(body);
    expect(first.status).toBe(202);
    const link = /\/f\/status\/([^"]+)"/.exec(first.text)![1]!;
    const again = await request(app).post('/f/submit').type('form').send(body); // refresh/retry, same UUID
    expect(again.status).toBe(200); // duplicate replay, not a new request
    const n = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE source='web' AND submission_id='web-uuid-1'`);
    expect(Number(n.rows[0]!.n)).toBe(1);
    const status = await request(app).get(`/f/status/${link}`);
    expect(status.status).toBe(200);
    expect(status.text).toContain('received');
  });

  it('mandatory email: missing/invalid → 422 (I8, FR-002)', async () => {
    const form_token = await getToken();
    const res = await request(app).post('/f/submit').type('form')
      .send({ form_token, email: '', description: 'x', submission_id: 'web-noemail', website: '', 'cf-turnstile-response': 'ok' });
    expect(res.status).toBe(422);
  });

  it('honeypot filled → 204 and nothing persisted (FR-004)', async () => {
    const before = await webCount();
    const form_token = await getToken();
    const res = await request(app).post('/f/submit').type('form')
      .send({ form_token, email: 'bot@example.com', description: 'spam', submission_id: 'web-bot', website: 'http://spam', 'cf-turnstile-response': 'ok' });
    expect(res.status).toBe(204);
    expect(await webCount()).toBe(before); // no request created
  });

  it('forged/invalid form token → 401 (FR-001)', async () => {
    const res = await request(app).post('/f/submit').type('form')
      .send({ form_token: 'f:deadbeef.not-a-real-mac', email: 'a@b.com', description: 'hi', submission_id: 'web-forged', website: '', 'cf-turnstile-response': 'ok' });
    expect(res.status).toBe(401);
  });

  it('oversize description → 422; failed bot check → 403', async () => {
    const form_token = await getToken();
    const big = await request(app).post('/f/submit').type('form')
      .send({ form_token, email: 'a@b.com', description: 'x'.repeat(20_001), submission_id: 'web-big', website: '', 'cf-turnstile-response': 'ok' });
    expect(big.status).toBe(422);
    const bot = await request(app).post('/f/submit').type('form')
      .send({ form_token, email: 'a@b.com', description: 'hello', submission_id: 'web-nobot', website: '', 'cf-turnstile-response': '' });
    expect(bot.status).toBe(403); // FakeTurnstile rejects an empty token
  });
});
