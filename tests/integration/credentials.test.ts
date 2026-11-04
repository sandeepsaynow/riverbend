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
import type { Config } from '../../src/platform/config/index.js';

const BOOT = 'cred-admin-secret';
const ADMIN = `rb_admin_bootstrap.${BOOT}`;
let t: TestDb;
let app: Express;
let auth: AuthService;

async function shop(slug: string): Promise<string> {
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ($1,'America/Chicago',$1) RETURNING id`, [slug]);
  return r.rows[0]!.id;
}
const events = (credId: string) => t.db.adminQuery<{ event: string }>(`SELECT event FROM credential_audit WHERE credential_id=$1 ORDER BY created_at`, [credId]).then((r) => r.rows.map((x) => x.event));

beforeAll(async () => {
  t = await startTestDb();
  auth = new AuthService(t.db);
  await auth.ensureBootstrapAdmin(BOOT);
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'development' } as unknown as Config;
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth, shops: new ShopsService(t.db), catalog: new CatalogService(t.db), intake: new IntakeService(t.db), orders: new OrdersService(t.db) });
  await shop('rb-cred');
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('009 credential lifecycle', () => {
  it('issue → authenticate with scopes; masked list never leaks the secret', async () => {
    const issued = await auth.issueShopCredential('rb-cred', { name: 'ci', scopes: ['orders:read'], expiresInDays: 30 });
    const principal = await auth.authenticate(issued.token);
    expect(principal?.kind).toBe('shop');
    expect(principal?.scopes).toEqual(['orders:read']);
    const masked = await auth.listShopCredentials('rb-cred');
    const row = masked.find((m) => m.id === issued.id)!;
    expect(row.prefix).toBe(issued.prefix);
    expect(JSON.stringify(masked)).not.toContain(issued.token.split('.')[1]!); // no secret
    expect(Object.keys(row)).not.toContain('secret');
    expect(Object.keys(row)).not.toContain('virtual_key'); // never a LiteLLM key
    expect(await events(issued.id)).toContain('issued');
  });

  it('expired key → 401 (treated as invalid)', async () => {
    const issued = await auth.issueShopCredential('rb-cred', { expiresInDays: 30 });
    await t.db.adminQuery(`UPDATE credentials SET expires_at = now() - interval '1 day' WHERE id=$1`, [issued.id]);
    expect(await auth.authenticate(issued.token)).toBeNull();
  });

  it('revoke → 401 + audit', async () => {
    const issued = await auth.issueShopCredential('rb-cred');
    expect(await auth.authenticate(issued.token)).not.toBeNull();
    expect(await auth.revokeCredential(issued.id)).toBe(true);
    expect(await auth.authenticate(issued.token)).toBeNull();
    expect(await events(issued.id)).toEqual(['issued', 'revoked']);
  });

  it('rotate → old key rejected, new key works; audit records the rotation', async () => {
    const old = await auth.issueShopCredential('rb-cred', { scopes: ['orders:read'] });
    const next = await auth.rotateCredential(old.id);
    expect(next).not.toBeNull();
    expect(await auth.authenticate(old.token)).toBeNull(); // old revoked
    const p = await auth.authenticate(next!.token);
    expect(p?.scopes).toEqual(['orders:read']); // scopes carried over
    expect(await events(old.id)).toEqual(['issued', 'revoked']);
    expect(await events(next!.id)).toEqual(['issued', 'rotated']);
  });
});

describe('009 scopes + admin endpoints + docs (HTTP)', () => {
  it('a scoped key without orders:read is 403 on /v1/orders; an unrestricted key is 200', async () => {
    const scoped = await auth.issueShopCredential('rb-cred', { scopes: ['intake:write'] });
    const open = await auth.issueShopCredential('rb-cred'); // empty scopes = unrestricted
    const a = await request(app).get('/v1/orders').set('Authorization', `Bearer ${scoped.token}`);
    expect(a.status).toBe(403);
    expect(a.body.error).toBe('insufficient_scope');
    const b = await request(app).get('/v1/orders').set('Authorization', `Bearer ${open.token}`);
    expect(b.status).toBe(200);
  });

  it('admin can issue, list (masked), and rotate via HTTP; list carries no secret', async () => {
    const issue = await request(app).post('/admin/shops/rb-cred/credentials').set('Authorization', `Bearer ${ADMIN}`).send({ name: 'http', scopes: ['orders:read'], expires_in_days: 7 });
    expect(issue.status).toBe(201);
    expect(issue.body.secret).toMatch(/^rb_shop_/);
    expect(issue.body.expires_at).toBeTruthy();
    const list = await request(app).get('/admin/shops/rb-cred/credentials').set('Authorization', `Bearer ${ADMIN}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(issue.body.secret.split('.')[1]);
    const rotate = await request(app).post(`/admin/credentials/${issue.body.id}/rotate`).set('Authorization', `Bearer ${ADMIN}`);
    expect(rotate.status).toBe(201);
    expect(rotate.body.secret).not.toBe(issue.body.secret);
    // a shop key may NOT use the admin listing route
    const asShop = await request(app).get('/admin/shops/rb-cred/credentials').set('Authorization', `Bearer ${rotate.body.secret}`);
    expect(asShop.status).toBe(403);
  });

  it('OpenAPI JSON + Swagger UI are served in non-production', async () => {
    const spec = await request(app).get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/v1/messages');
    const docs = await request(app).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui');
  });
});
