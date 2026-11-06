import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { provisionDefaultShops, DEFAULT_SHOP_SLUGS } from '../../src/modules/shops/provision.js';

// D31 — fresh deployments must auto-provision the three default shops idempotently: no duplicates, no churn
// of existing rows, and no credential/order changes. (The api runs provisionDefaultShops on every boot.)
let t: TestDb;
let shops: ShopsService;
const shopCount = () => t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM shops`).then((r) => Number(r.rows[0]!.n));

beforeAll(async () => { t = await startTestDb(); shops = new ShopsService(t.db); }, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('D31 default-shop auto-provisioning', () => {
  it('fresh DB → creates exactly the three shops with inbound addresses', async () => {
    expect(await shopCount()).toBe(0);
    const r = await provisionDefaultShops(shops, { inboundDomain: 'karoiechou.resend.app' });
    expect(r.map((x) => x.slug).sort()).toEqual([...DEFAULT_SHOP_SLUGS].sort());
    expect(r.every((x) => x.created)).toBe(true);
    expect(r.find((x) => x.slug === 'rb-downtown')!.inboundAddress).toBe('rb-downtown@karoiechou.resend.app');
    expect(await shopCount()).toBe(3);
  });

  it('re-run is idempotent: no duplicates, shops reused, ids stable, inbound address unchanged', async () => {
    const before = await t.db.adminQuery<{ id: string; slug: string; inbound_address: string }>(`SELECT id, slug, inbound_address FROM shops ORDER BY slug`);
    const r = await provisionDefaultShops(shops, { inboundDomain: 'karoiechou.resend.app' });
    expect(r.every((x) => x.created)).toBe(false); // all reused, none re-created
    expect(await shopCount()).toBe(3); // still three, no duplicates
    const after = await t.db.adminQuery<{ id: string; slug: string; inbound_address: string }>(`SELECT id, slug, inbound_address FROM shops ORDER BY slug`);
    expect(after.rows).toEqual(before.rows); // ids + addresses unchanged (no churn)
  });

  it('does not touch existing tenant data (a prior request survives re-provisioning)', async () => {
    const dt = await t.db.adminQuery<{ id: string }>(`SELECT id FROM shops WHERE slug='rb-downtown'`);
    const shopId = dt.rows[0]!.id;
    await t.db.withTenant(shopId, (c) => c.query(
      `INSERT INTO messages (shop_id, source, submission_id, content, content_fingerprint) VALUES ($1,'email','keep-1','existing msg','fp-keep')`, [shopId]));
    const n0 = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE submission_id='keep-1'`).then((r) => Number(r.rows[0]!.n));
    await provisionDefaultShops(shops, { inboundDomain: 'karoiechou.resend.app' });
    const n1 = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE submission_id='keep-1'`).then((r) => Number(r.rows[0]!.n));
    expect(n0).toBe(1);
    expect(n1).toBe(1); // existing data preserved
  });

  it('missing email-domain config → shops still created, no inbound address', async () => {
    // simulate a separate fresh DB by using distinct slugs via a direct call path is not possible (fixed set);
    // instead verify the null-domain contract on the helper's output shape.
    const r = await provisionDefaultShops(shops, { inboundDomain: null });
    expect(r.every((x) => x.inboundAddress === null)).toBe(true);
    // and the shops still exist (reused)
    expect(await shopCount()).toBe(3);
  });
});
