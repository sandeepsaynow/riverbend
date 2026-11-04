import type { Db } from '../../platform/db/index.js';
import type { Auth } from '../../platform/auth/better-auth.js';

/**
 * Riverbend-owned authorization for the staff portal (010). Better Auth owns identity/sessions; this
 * service owns the shop binding: one-time admin init, admin-created staff + membership, and the
 * session→user→active-membership→shop resolution that feeds the existing tenant-bound services (RLS).
 * Fields are allow-listed (no mass assignment of role/shop/admin status); passwords never pass through
 * here in plaintext beyond the create call to Better Auth (which hashes them).
 */
export type AppRole = 'SHOP_ADMIN' | 'SHOP_STAFF';
export interface Membership { shopId: string; role: string; status: string }

export class PortalError extends Error {}
export class AlreadyInitialized extends PortalError {}

export class AuthPortalService {
  constructor(private readonly db: Db, private readonly auth: Auth) {}

  /** One-time first-admin init. Reserves the singleton marker atomically, then creates the admin. */
  async initFirstAdmin(input: { email: string; password: string; name: string }): Promise<{ userId: string }> {
    // Reserve the single-use boundary first (PK id=true → a 2nd/concurrent attempt conflicts).
    try {
      await this.db.adminQuery(`INSERT INTO auth_bootstrap (id) VALUES (true)`);
    } catch {
      throw new AlreadyInitialized('admin already initialized');
    }
    try {
      const created = await this.auth.api.createUser({ body: { email: input.email, password: input.password, name: input.name, role: 'admin' } });
      const userId = (created as { user: { id: string } }).user.id;
      await this.db.adminQuery(`UPDATE auth_bootstrap SET admin_user_id = $1 WHERE id = true`, [userId]);
      return { userId };
    } catch (err) {
      // Compensate so init can be retried (the admin was not created).
      await this.db.adminQuery(`DELETE FROM auth_bootstrap WHERE id = true`);
      throw err;
    }
  }

  async isInitialized(): Promise<boolean> {
    const r = await this.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM auth_bootstrap`);
    return Number(r.rows[0]!.n) > 0;
  }

  /** Admin-created staff (allow-listed fields only). Creates the Better Auth user + shop membership. */
  async createStaff(input: { email: string; name: string; password: string; shopId: string; role: AppRole }): Promise<{ userId: string }> {
    if (input.role !== 'SHOP_ADMIN' && input.role !== 'SHOP_STAFF') throw new PortalError('invalid role');
    const created = await this.auth.api.createUser({ body: { email: input.email, password: input.password, name: input.name, role: 'user' } });
    const userId = (created as { user: { id: string } }).user.id;
    await this.db.withTenant(input.shopId, (c) =>
      c.query(`INSERT INTO shop_membership (user_id, shop_id, role, status) VALUES ($1, $2, $3, 'active')`, [userId, input.shopId, input.role]),
    );
    return { userId };
  }

  /** Active memberships for a user (shop + app role). Cross-shop read is app_admin (identity path). */
  async membershipsFor(userId: string): Promise<Membership[]> {
    const r = await this.db.adminQuery<{ shop_id: string; role: string; status: string }>(
      `SELECT shop_id, role, status FROM shop_membership WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    return r.rows.map((x) => ({ shopId: x.shop_id, role: x.role, status: x.status }));
  }

  /**
   * Disable a staff account: ban in Better Auth, revoke sessions, and disable memberships. The admin's
   * request `headers` are passed through so Better Auth authorizes these admin-plugin operations.
   */
  async disableStaff(userId: string, headers: Headers): Promise<void> {
    await this.auth.api.banUser({ body: { userId }, headers });
    await this.auth.api.revokeUserSessions({ body: { userId }, headers });
    await this.db.adminQuery(`UPDATE shop_membership SET status = 'disabled' WHERE user_id = $1`, [userId]);
  }

  /** Staff listing for the admin UI (masked — no password/secret). */
  async listStaff(): Promise<Array<{ userId: string; email: string; name: string; shopId: string; role: string; status: string }>> {
    const r = await this.db.adminQuery<{ user_id: string; shop_id: string; role: string; status: string }>(
      `SELECT user_id, shop_id, role, status FROM shop_membership ORDER BY created_at DESC`,
    );
    const out: Array<{ userId: string; email: string; name: string; shopId: string; role: string; status: string }> = [];
    for (const m of r.rows) {
      const u = await this.auth.api.listUsers({ query: { filterField: 'id', filterValue: m.user_id, filterOperator: 'eq', limit: 1 } }).catch(() => null);
      const user = (u as { users?: Array<{ email: string; name: string }> } | null)?.users?.[0];
      out.push({ userId: m.user_id, email: user?.email ?? '(unknown)', name: user?.name ?? '', shopId: m.shop_id, role: m.role, status: m.status });
    }
    return out;
  }
}
