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
  scopes: string[];
  expires_at: string | null;
}

export interface IssuedCredential {
  id: string;
  prefix: string;
  token: string; // shown exactly once
  shopId: string;
  scopes: string[];
  expiresAt: string | null;
}

export interface IssueOptions {
  name?: string;
  scopes?: string[];
  expiresInDays?: number;
}

/** A credential as shown to operators — masked: prefix + metadata, never the secret. */
export interface MaskedCredential {
  id: string;
  kind: CredentialKind;
  prefix: string;
  name: string | null;
  scopes: string[];
  status: 'active' | 'revoked';
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
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
      `SELECT id, kind, shop_id, secret_fingerprint, status, scopes, expires_at
         FROM credentials WHERE kind = $1 AND prefix = $2`,
      [parsed.kind, parsed.prefix],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'active') return null;
    if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return null; // expired → 401 (009)
    if (!secretsMatch(parsed.secret, row.secret_fingerprint)) return null;

    await this.db.adminQuery(`UPDATE credentials SET last_used_at = now() WHERE id = $1`, [row.id]);
    return { credentialId: row.id, kind: row.kind, shopId: row.shop_id, scopes: row.scopes ?? [] };
  }

  /** Issue a new shop credential (FR-007/008). The full token is returned once, then only stored hashed. */
  async issueShopCredential(shopSlug: string, opts: IssueOptions = {}): Promise<IssuedCredential> {
    const shop = await this.db.adminQuery<{ id: string }>(
      `SELECT id FROM shops WHERE slug = $1`,
      [shopSlug],
    );
    const shopId = shop.rows[0]?.id;
    if (!shopId) return Promise.reject(new ShopNotFound(shopSlug));

    const cred = generateCredential('shop');
    const scopes = opts.scopes ?? []; // empty = unrestricted (backward-compatible)
    const expiresAt = opts.expiresInDays !== undefined
      ? new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString()
      : null;
    const inserted = await this.db.adminQuery<{ id: string }>(
      `INSERT INTO credentials (kind, shop_id, prefix, secret_fingerprint, name, scopes, expires_at)
       VALUES ('shop', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [shopId, cred.prefix, cred.fingerprint, opts.name ?? null, scopes, expiresAt],
    );
    const id = inserted.rows[0]!.id;
    await this.audit(id, shopId, 'issued', opts.name ?? null);
    return { id, prefix: cred.prefix, token: cred.token, shopId, scopes, expiresAt };
  }

  /** Revoke one credential (FR-009). Returns false if no active credential with that id exists. */
  async revokeCredential(id: string): Promise<boolean> {
    const res = await this.db.adminQuery<{ shop_id: string | null }>(
      `UPDATE credentials SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND status = 'active' RETURNING shop_id`,
      [id],
    );
    if ((res.rowCount ?? 0) === 0) return false;
    await this.audit(id, res.rows[0]!.shop_id, 'revoked', null);
    return true;
  }

  /** Rotate a shop credential (009): revoke the old, issue a replacement with the SAME shop + scopes. */
  async rotateCredential(id: string): Promise<IssuedCredential | null> {
    const existing = await this.db.adminQuery<{ shop_id: string | null; scopes: string[]; name: string | null; status: string }>(
      `SELECT shop_id, scopes, name, status FROM credentials WHERE id = $1 AND kind = 'shop'`,
      [id],
    );
    const row = existing.rows[0];
    if (!row || !row.shop_id) return null;
    const slug = await this.db.adminQuery<{ slug: string }>(`SELECT slug FROM shops WHERE id = $1`, [row.shop_id]);
    if (!slug.rows[0]) return null;
    await this.revokeCredential(id); // idempotent: no-op audit skipped if already revoked
    const issued = await this.issueShopCredential(slug.rows[0].slug, { scopes: row.scopes, ...(row.name ? { name: row.name } : {}) });
    await this.audit(issued.id, issued.shopId, 'rotated', `replaces ${id}`);
    return issued;
  }

  /** List a shop's credentials, MASKED — prefix + metadata only, never the secret (FR-004). */
  async listShopCredentials(shopSlug: string): Promise<MaskedCredential[]> {
    const shop = await this.db.adminQuery<{ id: string }>(`SELECT id FROM shops WHERE slug = $1`, [shopSlug]);
    const shopId = shop.rows[0]?.id;
    if (!shopId) return Promise.reject(new ShopNotFound(shopSlug));
    const res = await this.db.adminQuery<MaskedCredential>(
      `SELECT id, kind, prefix, name, scopes, status, created_at, expires_at, last_used_at, revoked_at
         FROM credentials WHERE shop_id = $1 ORDER BY created_at DESC`,
      [shopId],
    );
    return res.rows;
  }

  private async audit(credentialId: string, shopId: string | null, event: 'issued' | 'revoked' | 'rotated', detail: string | null): Promise<void> {
    await this.db.adminQuery(
      `INSERT INTO credential_audit (credential_id, shop_id, event, detail) VALUES ($1, $2, $3, $4)`,
      [credentialId, shopId, event, detail],
    );
  }
}

export class ShopNotFound extends Error {
  constructor(readonly slug: string) {
    super(`No such shop: ${slug}`);
  }
}
