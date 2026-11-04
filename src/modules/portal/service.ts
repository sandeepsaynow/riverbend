import type { Pool } from 'pg';
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
interface MarkerRow { admin_user_id: string | null; admin_email: string | null; status: string }

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Better Auth's duplicate-email error (admin createUser) — the reconcile signal. */
function isUserExists(err: unknown): boolean {
  const body = (err as { body?: { code?: string } } | null)?.body;
  return body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL';
}

export class PortalError extends Error {}
export class AlreadyInitialized extends PortalError {}
/** A prior init/creation left an unrecoverable partial state that needs an explicit operator step. */
export class RecoveryRequired extends PortalError {}

export class AuthPortalService {
  constructor(private readonly db: Db, private readonly auth: Auth, private readonly authPool: Pool) {}

  /**
   * One-time first-admin init as a **recoverable two-phase marker** (D20.1). Better Auth (its own pool)
   * and the `auth_bootstrap` marker (app_admin pool) cannot share one transaction, so instead of
   * pretending they're atomic we make the flow idempotent and reconcilable:
   *   1. Reserve the singleton marker bound to this admin email (`id=true` PK serializes concurrency).
   *   2. If the marker is already COMPLETE (`admin_user_id IS NOT NULL`) → reject (409).
   *   3. Otherwise (fresh reservation, or a prior crashed/failed attempt) create the admin — or, if a
   *      prior attempt already created it (`USER_ALREADY_EXISTS`), reuse that user after verifying it has
   *      a usable credential — then record `admin_user_id` to mark completion.
   * On any error the marker is left PENDING (not deleted), so a retry reconciles rather than locking out.
   * A crash between steps leaves a PENDING marker that the next retry completes. No duplicate admin: the
   * marker binds to one email, and a concurrent/retry attempt converges on the same user id.
   */
  async initFirstAdmin(input: { email: string; password: string; name: string }): Promise<{ userId: string }> {
    const email = input.email;
    // 1. Reserve or read the singleton marker (bound to the admin email).
    const ins = await this.db.adminQuery<MarkerRow>(
      `INSERT INTO auth_bootstrap (id, admin_email, status) VALUES (true, $1, 'pending')
       ON CONFLICT (id) DO NOTHING
       RETURNING admin_user_id, admin_email, status`,
      [email],
    );
    let marker = ins.rows[0];
    if (!marker) {
      const cur = await this.db.adminQuery<MarkerRow>(`SELECT admin_user_id, admin_email, status FROM auth_bootstrap WHERE id = true`);
      marker = cur.rows[0]!;
    }
    // 2. Truly completed (a usable admin was recorded) → single-use gate holds.
    if (marker.admin_user_id) throw new AlreadyInitialized('admin already initialized');
    // Pending/incomplete: bind the retry to the original email (prevents a second, different admin).
    if (marker.admin_email && marker.admin_email !== email) {
      throw new RecoveryRequired('initialization is pending for a different admin email — retry with that email, or run operator recovery');
    }
    if (!marker.admin_email) {
      await this.db.adminQuery(`UPDATE auth_bootstrap SET admin_email = $1 WHERE id = true`, [email]); // adopt (legacy/stuck marker)
    }
    // 3. Create the admin, or reconcile a prior partial attempt (idempotent by email).
    let userId: string;
    try {
      const created = await this.auth.api.createUser({ body: { email, password: input.password, name: input.name, role: 'admin' } });
      userId = (created as { user: { id: string } }).user.id;
    } catch (err) {
      if (!isUserExists(err)) throw err; // genuine failure → marker stays PENDING (retryable), not a lockout
      const existing = await this.findUserIdByEmail(email); // a prior (or concurrent) attempt created the user
      if (!existing) throw err;
      // A concurrent attempt may be mid-flight (its user row is visible before its credential/marker commit).
      // Wait briefly for it to either complete the marker or finish the credential — this disambiguates a
      // transient race from a *persistent* credential-less orphan without ever falsely marking complete.
      let hasCred = await this.hasCredential(existing);
      for (let i = 0; i < 20 && !hasCred; i++) {
        const m = await this.db.adminQuery<MarkerRow>(`SELECT admin_user_id, admin_email, status FROM auth_bootstrap WHERE id = true`);
        if (m.rows[0]?.admin_user_id) throw new AlreadyInitialized('admin already initialized'); // the concurrent winner finished
        await delay(100);
        hasCred = await this.hasCredential(existing);
      }
      if (!hasCred) {
        // Pathological, persistent: a user exists with no password credential (cannot be fixed headerless —
        // setUserPassword is UNAUTHORIZED without an admin session). Flag for operator recovery; do NOT complete.
        throw new RecoveryRequired('an incomplete admin account exists without a password credential — run operator recovery (docs/FINAL_MANUAL_TEST.md) then re-initialize');
      }
      userId = existing; // the prior attempt produced a usable admin; just finish recording it
    }
    await this.db.adminQuery(`UPDATE auth_bootstrap SET admin_user_id = $1, status = 'completed', initialized_at = now() WHERE id = true`, [userId]);
    return { userId };
  }

  /** Initialized ⟺ a usable admin was recorded. A pending/failed marker is NOT "initialized". */
  async isInitialized(): Promise<boolean> {
    const r = await this.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM auth_bootstrap WHERE admin_user_id IS NOT NULL`);
    return Number(r.rows[0]!.n) > 0;
  }

  /**
   * Admin-created staff (allow-listed fields only): create the Better Auth user, then the shop membership.
   * Retry-safe: the shop is verified first (no orphan identity on a bad shop); a duplicate email is only
   * reconciled when it belongs to an **orphan** identity (no membership anywhere) — a real existing account
   * is never silently attached to a new shop. The membership upsert is idempotent (unique(user,shop)).
   */
  async createStaff(input: { email: string; name: string; password: string; shopId: string; role: AppRole }): Promise<{ userId: string }> {
    if (input.role !== 'SHOP_ADMIN' && input.role !== 'SHOP_STAFF') throw new PortalError('invalid role');
    const shop = await this.db.adminQuery(`SELECT 1 FROM shops WHERE id = $1`, [input.shopId]);
    if (shop.rows.length === 0) throw new PortalError('unknown shop'); // fail BEFORE creating an identity
    let userId: string;
    try {
      const created = await this.auth.api.createUser({ body: { email: input.email, password: input.password, name: input.name, role: 'user' } });
      userId = (created as { user: { id: string } }).user.id;
    } catch (err) {
      if (!isUserExists(err)) throw err;
      const existing = await this.findUserIdByEmail(input.email);
      if (!existing) throw err;
      const any = await this.db.adminQuery<{ n: string }>(`SELECT count(*)::text AS n FROM shop_membership WHERE user_id = $1`, [existing]);
      if (Number(any.rows[0]!.n) > 0) throw new PortalError('email already in use'); // real account — do not touch
      userId = existing; // orphan identity from a failed prior creation → safe to complete
    }
    await this.db.withTenant(input.shopId, (c) =>
      c.query(
        `INSERT INTO shop_membership (user_id, shop_id, role, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (user_id, shop_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
        [userId, input.shopId, input.role],
      ),
    );
    return { userId };
  }

  /** Look up a Better Auth user id by email (migrator pool; identity path, read-only, no PII logged). */
  private async findUserIdByEmail(email: string): Promise<string | null> {
    const r = await this.authPool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1 LIMIT 1`, [email]);
    return r.rows[0]?.id ?? null;
  }

  /** Whether a user has a usable password credential (migrator pool, read-only). */
  private async hasCredential(userId: string): Promise<boolean> {
    const r = await this.authPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "account" WHERE "providerId" = 'credential' AND "userId" = $1`, [userId]);
    return Number(r.rows[0]!.n) > 0;
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
