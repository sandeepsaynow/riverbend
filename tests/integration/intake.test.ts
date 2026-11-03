import { randomUUID } from 'node:crypto';
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
import { IntakeService, ConflictError, ValidationError } from '../../src/modules/intake/index.js';
import { processRequest } from '../../src/worker/processor.js';
import { relayOnce } from '../../src/worker/relay.js';
import { handleExhausted } from '../../src/worker/sweeper.js';
import type { JobPayload, JobQueue } from '../../src/platform/queue/index.js';
import type { Config } from '../../src/platform/config/index.js';

const BOOT = 'intake-admin-secret';
const ADMIN = `rb_admin_bootstrap.${BOOT}`;

class FakeQueue implements JobQueue {
  readonly published: Array<{ name: string; payload: JobPayload }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async publish(name: string, payload: JobPayload): Promise<void> {
    this.published.push({ name, payload });
  }
  async work(): Promise<void> {}
}

let t: TestDb;
let app: Express;
let intake: IntakeService;
let shopAId: string;
let shopBId: string;
let keyA: string;
let keyB: string;

async function createShopViaApi(slug: string): Promise<{ id: string; key: string }> {
  const created = await request(app).post('/admin/shops').set('Authorization', `Bearer ${ADMIN}`).send({ slug, time_zone: 'America/Chicago' });
  expect(created.status).toBe(201);
  const issued = await request(app).post(`/admin/shops/${slug}/credentials`).set('Authorization', `Bearer ${ADMIN}`);
  return { id: created.body.id as string, key: issued.body.secret as string };
}
function count(table: string, shopId: string): Promise<number> {
  return t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE shop_id = $1`, [shopId]).then((r) => Number(r.rows[0]!.n));
}

beforeAll(async () => {
  t = await startTestDb();
  const auth = new AuthService(t.db);
  await auth.ensureBootstrapAdmin(BOOT);
  const shops = new ShopsService(t.db);
  const catalog = new CatalogService(t.db);
  intake = new IntakeService(t.db);
  const config = { DATABASE_ADMIN_URL: t.adminUrl, LOG_LEVEL: 'fatal' } as unknown as Config;
  app = createApp({ config, db: t.db, logger: createLogger('fatal'), auth, shops, catalog, intake });
  const a = await createShopViaApi('rb-a');
  const b = await createShopViaApi('rb-b');
  shopAId = a.id; keyA = a.key; shopBId = b.id; keyB = b.key;
}, 180_000);

afterAll(async () => {
  if (t) await stopTestDb(t);
});

describe('US1 — accept once, atomic (FR-002)', () => {
  it('persists message+request+job_outbox atomically and returns received', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'email', submissionId: 'm-1001', content: 'tune-up please' });
    expect(r.state).toBe('received');
    expect(r.duplicate).toBe(false);
    expect(await count('messages', shopAId)).toBe(1);
    expect(await count('requests', shopAId)).toBe(1);
    expect(await count('job_outbox', shopAId)).toBe(1);
  });

  it('persists nothing when the atomic write cannot complete (bad shop → FK violation)', async () => {
    const ghost = randomUUID();
    await expect(
      intake.submit({ shopId: ghost, source: 'email', submissionId: 'g-1', content: 'x' }),
    ).rejects.toBeTruthy();
    expect(await count('messages', ghost)).toBe(0);
  });
});

describe('US2 — idempotency (FR-004/005/006/007/015)', () => {
  it('50 concurrent identical submissions → exactly one request (SC-002, m-1003)', async () => {
    const submits = Array.from({ length: 50 }, () =>
      intake.submit({ shopId: shopAId, source: 'email', submissionId: 'm-1003', content: 'the chain keeps slipping' }),
    );
    const results = await Promise.all(submits);
    const ids = new Set(results.map((r) => r.requestId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const n = await t.db.adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM messages WHERE shop_id=$1 AND source='email' AND submission_id='m-1003'`,
      [shopAId],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('same id + different content → 409; whitespace-only diff → replay (SC-003)', async () => {
    await intake.submit({ shopId: shopAId, source: 'web', submissionId: 's-1', content: 'brake squeal' });
    await expect(
      intake.submit({ shopId: shopAId, source: 'web', submissionId: 's-1', content: 'totally different' }),
    ).rejects.toBeInstanceOf(ConflictError);
    const replay = await intake.submit({ shopId: shopAId, source: 'web', submissionId: 's-1', content: '  brake   squeal  ' });
    expect(replay.duplicate).toBe(true);
  });

  it('different ids + identical content → two requests (SC-008); bad input → validation errors', async () => {
    const r1 = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'id-1', content: 'same words' });
    const r2 = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'id-2', content: 'same words' });
    expect(r1.requestId).not.toBe(r2.requestId);
    await expect(intake.submit({ shopId: shopAId, source: 'api', submissionId: '', content: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await expect(intake.submit({ shopId: shopAId, source: 'api', submissionId: 'big', content: 'x'.repeat(20_001) })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('US2 — HTTP contract (202/409/422)', () => {
  it('POST /v1/messages → 202 with request_id + status_url; replay returns same id', async () => {
    const res = await request(app).post('/v1/messages').set('Authorization', `Bearer ${keyA}`).send({ source: 'email', submission_id: 'h-1', content: 'hi' });
    expect(res.status).toBe(202);
    expect(res.body.request_id).toBeTruthy();
    expect(res.body.status_url).toBe(`/v1/requests/${res.body.request_id}`);
    const again = await request(app).post('/v1/messages').set('Authorization', `Bearer ${keyA}`).send({ source: 'email', submission_id: 'h-1', content: 'hi' });
    expect(again.status).toBe(202);
    expect(again.body.request_id).toBe(res.body.request_id);
  });
  it('same id + different content → 409; missing id → 422; oversize → 422', async () => {
    await request(app).post('/v1/messages').set('Authorization', `Bearer ${keyA}`).send({ source: 'web', submission_id: 'h-2', content: 'a' });
    const conflict = await request(app).post('/v1/messages').set('Authorization', `Bearer ${keyA}`).send({ source: 'web', submission_id: 'h-2', content: 'b' });
    expect(conflict.status).toBe(409);
    const noId = await request(app).post('/v1/messages').set('Authorization', `Bearer ${keyA}`).send({ source: 'web', content: 'a' });
    expect(noId.status).toBe(422);
    const oversize = await request(app).post('/v1/messages').set('Authorization', `Bearer ${keyA}`).send({ source: 'web', submission_id: 'h-3', content: 'x'.repeat(20_001) });
    expect(oversize.status).toBe(422);
  });
});

describe('US3 — worker processing & recovery', () => {
  it('processor advances to awaiting_pipeline idempotently (SC-004)', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'w-1', content: 'x' });
    const payload = { requestId: r.requestId, shopId: shopAId };
    await processRequest(t.db, payload);
    await processRequest(t.db, payload); // redelivery/replay → no-op
    const st = await intake.getRequestStatus(shopAId, r.requestId);
    expect(st?.state).toBe('awaiting_pipeline');
    const att = await t.db.adminQuery<{ attempts: number }>(`SELECT attempts FROM requests WHERE id=$1`, [r.requestId]);
    expect(att.rows[0]!.attempts).toBe(1);
  });

  it('relay delivers pending outbox to the queue, then the job processes (FR-010 rebuild)', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'w-2', content: 'x' });
    const fake = new FakeQueue();
    const n = await relayOnce(t.db, fake);
    expect(n).toBeGreaterThanOrEqual(1);
    const mine = fake.published.find((p) => p.payload.requestId === r.requestId);
    expect(mine?.payload).toEqual({ requestId: r.requestId, shopId: shopAId });
    const pend = await t.db.adminQuery<{ status: string }>(`SELECT status FROM job_outbox WHERE request_id=$1`, [r.requestId]);
    expect(pend.rows[0]!.status).toBe('published');
    await processRequest(t.db, mine!.payload);
    expect((await intake.getRequestStatus(shopAId, r.requestId))?.state).toBe('awaiting_pipeline');
  });

  it('dead-letter handler parks the request in needs_review on exhaustion (FR-011)', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'w-3', content: 'x' });
    await handleExhausted(t.db, { requestId: r.requestId, shopId: shopAId });
    expect((await intake.getRequestStatus(shopAId, r.requestId))?.state).toBe('needs_review');
  });

  it('processing is tenant-bound: another shop cannot advance a request (RLS, FR-014)', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'w-4', content: 'x' });
    await processRequest(t.db, { requestId: r.requestId, shopId: shopBId }); // wrong tenant → no-op under RLS
    expect((await intake.getRequestStatus(shopAId, r.requestId))?.state).toBe('received');
  });
});

describe('US4 & privacy', () => {
  it('status is tenant-scoped: owner sees it, another shop gets null/404 (SC-006)', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'st-1', content: 'x' });
    expect((await intake.getRequestStatus(shopAId, r.requestId))?.request_id).toBe(r.requestId);
    expect(await intake.getRequestStatus(shopBId, r.requestId)).toBeNull();
    const cross = await request(app).get(`/v1/requests/${r.requestId}`).set('Authorization', `Bearer ${keyB}`);
    expect(cross.status).toBe(404);
  });

  it('customer content never leaves via the API DTO or the job payload (FR-018)', async () => {
    const r = await intake.submit({ shopId: shopAId, source: 'api', submissionId: 'pv-1', content: 'SECRET-PII-12345' });
    const st = await intake.getRequestStatus(shopAId, r.requestId);
    expect(JSON.stringify(st)).not.toContain('SECRET-PII-12345'); // status DTO carries no content
    const fake = new FakeQueue();
    await relayOnce(t.db, fake);
    for (const p of fake.published) expect(Object.keys(p.payload).sort()).toEqual(['requestId', 'shopId']); // ids only
  });
});
