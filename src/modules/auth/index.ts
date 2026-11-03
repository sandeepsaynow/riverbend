import type { Db } from '../../platform/db/index.js';
import type { AuthContext } from '../../platform/http/tenant-context.js';
import {
  fingerprint,
  generateCredential,
  parseToken,
  secretsMatch,
  type CredentialKind,
} from './credential.js';

const BOOTSTRAP_PREFIX = 'bootstrap';

interface CredentialRow {
  id: string;
  kind: CredentialKind;
  shop_id: string | null;
  secret_fingerprint: Buffer;
  status: 'active' | 'revoked';
}

export interface IssuedCredential {
  id: string;
  prefix: string;
  token: string; // shown exactly once
  shopId: string;
}

export class AuthService {
  constructor(private readonly db: Db) {}

  /**
   * Fail-closed bootstrap (FR-021): derive the initial admin credential from configuration and
   * upsert it. No default/hardcoded credential exists; a missing/empty token is already rejected
   * by config (FR-014), and this method is the only way an admin credential first appears.
   */
  async ensureBootstrapAdmin(bootstrapSecret: string): Promise<void> {
    if (!bootstrapSecret || bootstrapSecret.trim() === '') {
      throw new Error('ADMIN_BOOTSTRAP_TOKEN is required to provision the bootstrap admin');
    }
    await this.db.adminQuery(
      `INSERT INTO credentials (kind, shop_id, prefix, secret_fingerprint, status)
       VALUES ('admin', NULL, $1, $2, 'active')
       ON CONFLICT (kind, prefix)
       DO UPDATE SET secret_fingerprint = EXCLUDED.secret_fingerprint, status = 'active', revoked_at = NULL`,
      [BOOTSTRAP_PREFIX, fingerprint(bootstrapSecret)],
    );
  }

  /** Authenticate a bearer token. Returns the principal, or null if it is not valid/active. */
  async authenticate(bearer: string): Promise<AuthContext | null> {
    const parsed = parseToken(bearer);
    if (!parsed) return null;

    const res = await this.db.adminQuery<CredentialRow>(
      `SELECT id, kind, shop_id, secret_fingerprint, status
         FROM credentials WHERE kind = $1 AND prefix = $2`,
      [parsed.kind, parsed.prefix],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'active') return null;
    if (!secretsMatch(parsed.secret, row.secret_fingerprint)) return null;

    await this.db.adminQuery(`UPDATE credentials SET last_used_at = now() WHERE id = $1`, [row.id]);
    return { credentialId: row.id, kind: row.kind, shopId: row.shop_id };
  }

  /** Issue a new shop credential (FR-007/008). The full token is returned once, then only stored hashed. */
  async issueShopCredential(shopSlug: string): Promise<IssuedCredential> {
    const shop = await this.db.adminQuery<{ id: string }>(
      `SELECT id FROM shops WHERE slug = $1`,
      [shopSlug],
    );
    const shopId = shop.rows[0]?.id;
    if (!shopId) return Promise.reject(new ShopNotFound(shopSlug));

    const cred = generateCredential('shop');
    const inserted = await this.db.adminQuery<{ id: string }>(
      `INSERT INTO credentials (kind, shop_id, prefix, secret_fingerprint)
       VALUES ('shop', $1, $2, $3) RETURNING id`,
      [shopId, cred.prefix, cred.fingerprint],
    );
    return { id: inserted.rows[0]!.id, prefix: cred.prefix, token: cred.token, shopId };
  }

  /** Revoke one credential (FR-009). Returns false if no active credential with that id exists. */
  async revokeCredential(id: string): Promise<boolean> {
    const res = await this.db.adminQuery(
      `UPDATE credentials SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

export class ShopNotFound extends Error {
  constructor(readonly slug: string) {
    super(`No such shop: ${slug}`);
  }
}
