import type { Db } from '../../platform/db/index.js';

export interface Shop {
  id: string;
  slug: string;
  time_zone: string;
  display_name: string;
  created_at: string;
}

export class ShopSlugTaken extends Error {
  constructor(readonly slug: string) {
    super(`Shop slug already in use: ${slug}`);
  }
}
export class InvalidTimeZone extends Error {
  constructor(readonly tz: string) {
    super(`Invalid IANA time zone: ${tz}`);
  }
}

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class ShopsService {
  constructor(private readonly db: Db) {}

  /** Create a shop (admin path, cross-shop role). FR-005/FR-006. */
  async createShop(input: { slug: string; timeZone: string; displayName?: string }): Promise<Shop> {
    const slug = input.slug.trim();
    if (!SLUG_RE.test(slug)) {
      // Shape error; surfaced as 422 by the route's Zod schema in normal flow, guarded here too.
      throw new InvalidSlug(slug);
    }
    if (!isValidTimeZone(input.timeZone)) throw new InvalidTimeZone(input.timeZone);
    const displayName = input.displayName?.trim() || slug;

    try {
      const res = await this.db.adminQuery<Shop>(
        `INSERT INTO shops (slug, time_zone, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, slug, time_zone, display_name, created_at`,
        [slug, input.timeZone, displayName],
      );
      return res.rows[0]!;
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
        throw new ShopSlugTaken(slug);
      }
      throw err;
    }
  }

  /** The caller's own shop, read as app_user bound to its tenant (RLS returns only its row). */
  async getOwnShop(shopId: string): Promise<Shop | null> {
    return this.db.withTenant(shopId, async (client) => {
      const res = await client.query<Shop>(
        `SELECT id, slug, time_zone, display_name, created_at FROM shops`,
      );
      return res.rows[0] ?? null;
    });
  }

  /** List all shops (admin/operator path, cross-shop — used by the staff portal admin UI, 010). */
  async listShops(): Promise<Shop[]> {
    const res = await this.db.adminQuery<Shop>(`SELECT id, slug, time_zone, display_name, created_at FROM shops ORDER BY slug`);
    return res.rows;
  }

  /**
   * Set (or clear) a shop's trusted inbound-email address by slug (D25, admin/ops path). This is the
   * ONLY source of truth for routing a brand-new inbound email to a tenant; it is never derived from the
   * sender. The address is stored verbatim; uniqueness is enforced case-insensitively by the DB index.
   */
  async setInboundAddress(slug: string, address: string | null): Promise<void> {
    await this.db.adminQuery(`UPDATE shops SET inbound_address = $2 WHERE slug = $1`, [slug.trim(), address?.trim() || null]);
  }

  /**
   * Resolve the shop that owns a verified destination address (D25, cross-shop admin read — the tenant is
   * not yet known). Case-insensitive. Returns null for an unknown address, so inbound to an unconfigured
   * or unknown recipient is never attributed to a tenant.
   */
  async resolveByInboundAddress(address: string): Promise<string | null> {
    const res = await this.db.adminQuery<{ id: string }>(
      `SELECT id FROM shops WHERE lower(inbound_address) = lower($1)`,
      [address.trim()],
    );
    return res.rows[0]?.id ?? null;
  }
}

export class InvalidSlug extends Error {
  constructor(readonly slug: string) {
    super(`Invalid shop slug: ${slug}`);
  }
}
