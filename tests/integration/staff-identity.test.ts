import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db.js';
import { findPolicyGaps } from '../../src/platform/db/policy-check.js';

let t: TestDb;
let shopId: string;

beforeAll(async () => {
  t = await startTestDb();
  const r = await t.db.adminQuery<{ id: string }>(`INSERT INTO shops (slug, time_zone, display_name) VALUES ('rb-id','America/Chicago','rb-id') RETURNING id`);
  shopId = r.rows[0]!.id;
}, 180_000);
afterAll(async () => { if (t) await stopTestDb(t); });

describe('010 foundation — staff identity schema', () => {
  it('shop_membership is under forced RLS with a policy (isolation check stays clean)', async () => {
    expect(await findPolicyGaps(t.db)).toEqual([]);
  });

  it('auth_bootstrap is a singleton — a second init row is rejected', async () => {
    await t.db.adminQuery(`INSERT INTO auth_bootstrap (admin_user_id) VALUES ('user-1')`);
    await expect(t.db.adminQuery(`INSERT INTO auth_bootstrap (admin_user_id) VALUES ('user-2')`)).rejects.toBeTruthy();
    const n = await t.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM auth_bootstrap`);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('shop_membership enforces unique(user_id, shop_id), role/status checks, and the shop FK', async () => {
    await t.db.adminQuery(`INSERT INTO shop_membership (user_id, shop_id, role) VALUES ('u-1',$1,'SHOP_STAFF')`, [shopId]);
    await expect(t.db.adminQuery(`INSERT INTO shop_membership (user_id, shop_id) VALUES ('u-1',$1)`, [shopId])).rejects.toBeTruthy(); // dup
    await expect(t.db.adminQuery(`INSERT INTO shop_membership (user_id, shop_id, role) VALUES ('u-2',$1,'GOD')`, [shopId])).rejects.toBeTruthy(); // bad role
    await expect(t.db.adminQuery(`INSERT INTO shop_membership (user_id, shop_id) VALUES ('u-3','00000000-0000-0000-0000-000000000000')`)).rejects.toBeTruthy(); // FK
  });
});
