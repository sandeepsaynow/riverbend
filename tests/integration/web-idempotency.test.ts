import { randomUUID } from 'node:crypto';
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

const KEY = 'test-web-idem-key';
let t: TestDb; let app: Express;
// A persistent agent = one browser/cookie jar across requests (the bug only showed with persistent state).
const agent = (): ReturnType<typeof request.agent> => request.agent(app);

const tokenOf = (html: string): string => /name="form_token" value="([^"]+)"/.exec(html)![1]!;
async function freshForm(a: ReturnType<typeof request.agent>, slug: string): Promise<string> {
  const page = await a.get(`/f/${slug}`);
  return tokenOf(page.text);
}
async function submit(a: ReturnType<typeof request.agent>, slug: string, token: string, fields: Record<string, string>): Promise<request.Response> {
  return a.post('/f/submit').type('form').send({ form_token: token, slug, website: '', 'cf-turnstile-response': 'ok', ...fields });
}
const webCount = async (sid: string): Promise<number> =>
  Number((await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text n FROM messages WHERE source='web' AND submission_id=$1`, [sid])).rows[0]!.n);

beforeAll(async () => {
  t = await startTestDb();
  const intake = new IntakeService(t.db);
  const web = new WebService(t.db, intake, { signingKey: KEY, turnstile: new FakeTurnstileVerifier() });
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', WEB_ALLOWED_ORIGINS: '' } as unknown as Config;
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth: new AuthService(t.db), shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake, orders: new OrdersService(t.db), web });
  await t.db.adminQuery(`INSERT INTO shops (slug, time_zone, display_name) VALUES ('rb-dt','America/Chicago','Downtown'), ('rb-ns','America/Chicago','Northside')`);
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('005/D24 — customer form operation-id lifecycle (persistent browser)', () => {
  it('REGRESSION — the form mints a FRESH operation id per load; it never reuses a persisted one', async () => {
    const html = (await agent().get('/f/rb-dt')).text;
    expect(html).not.toContain('localStorage.getItem'); // the old bug: a persisted, reused submission id
    expect(html).toContain('crypto.randomUUID'); // fresh per form instance
    expect(html).toContain('e.persisted'); // regenerate on Back/Forward (BFCache) restore
  });

  it('three independent submissions in ONE browser (fresh ids, incl. across shops) all succeed', async () => {
    const a = agent();
    const subs = [
      { slug: 'rb-dt', email: 'c1@x.com', description: 'basic tune-up' },
      { slug: 'rb-dt', email: 'c2@x.com', description: 'rear brake adjustment' }, // same browser+shop, different request
      { slug: 'rb-ns', email: 'c1@x.com', description: 'chain replacement' }, // same browser, different shop + same email
    ];
    for (const s of subs) {
      const token = await freshForm(a, s.slug); // a new form load → the client would mint a fresh id
      const sid = randomUUID(); // simulate the fixed client's fresh-per-load id
      const res = await submit(a, s.slug, token, { email: s.email, description: s.description, submission_id: sid });
      expect(res.status, JSON.stringify(s)).toBe(303); // accepted (PRG), NOT a 409 conflict
      expect(await webCount(sid)).toBe(1);
    }
    const total = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text n FROM messages WHERE source='web'`);
    expect(Number(total.rows[0]!.n)).toBe(3); // three distinct requests, not one reused id
  });

  it('same id + same payload → idempotent replay (one request); same id + different payload → 409', async () => {
    const a = agent();
    const token1 = await freshForm(a, 'rb-dt');
    const sid = randomUUID();
    const r1 = await submit(a, 'rb-dt', token1, { email: 'd@x.com', description: 'flat tire', submission_id: sid });
    expect(r1.status).toBe(303);
    const token2 = await freshForm(a, 'rb-dt');
    const replay = await submit(a, 'rb-dt', token2, { email: 'd@x.com', description: 'flat tire', submission_id: sid }); // retry
    expect(replay.status).toBe(303); // duplicate replay
    expect(await webCount(sid)).toBe(1); // still one request
    const token3 = await freshForm(a, 'rb-dt');
    const conflict = await submit(a, 'rb-dt', token3, { email: 'd@x.com', description: 'DIFFERENT text now', submission_id: sid });
    expect(conflict.status).toBe(409); // reuse of a consumed id with different content → conflict (backend intact)
  });

  it('a tampered form token is rejected (signed-form protection intact)', async () => {
    const a = agent();
    const bad = await submit(a, 'rb-dt', 'not.a.valid.token', { email: 'e@x.com', description: 'x', submission_id: randomUUID() });
    expect(bad.status).toBe(401);
  });

  it('an unknown shop form → 404', async () => {
    expect((await agent().get('/f/does-not-exist')).status).toBe(404);
  });

  it('a request routes to the correct tenant (cross-shop isolation by the signed token)', async () => {
    const a = agent();
    const token = await freshForm(a, 'rb-ns');
    const sid = randomUUID();
    await submit(a, 'rb-ns', token, { email: 'iso@x.com', description: 'northside tune', submission_id: sid });
    const row = await t.db.adminQuery<{ slug: string }>(
      `SELECT s.slug FROM messages m JOIN requests r ON r.message_id=m.id JOIN shops s ON s.id=r.shop_id WHERE m.submission_id=$1`, [sid]);
    expect(row.rows[0]!.slug).toBe('rb-ns'); // landed under Northside, not Downtown
  });

  it('a recoverable validation error re-renders the form with the input preserved + a fresh token', async () => {
    const a = agent();
    const token = await freshForm(a, 'rb-dt');
    const res = await submit(a, 'rb-dt', token, { email: '', description: 'my gears skip under load', submission_id: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.text).toContain('my gears skip under load'); // description preserved
    expect(res.text).toContain('name="form_token"'); // a fresh form token to retry
    expect(res.text).toContain('crypto.randomUUID'); // and a fresh operation id on retry
  });
});
