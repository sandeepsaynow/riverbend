import { ShopsService, ShopSlugTaken } from './index.js';

/** The brief's fixed three-shop chain. The authoritative default set provisioned on every boot. */
export const DEFAULT_SHOP_SLUGS = ['rb-downtown', 'rb-northside', 'rb-lakeshore'] as const;
const DEFAULT_TZ = 'America/Chicago';

export interface ProvisionResult {
  slug: string;
  created: boolean; // true = newly created this run; false = already existed (reused)
  inboundAddress: string | null;
}

/**
 * Ensure the three default shops exist and own their trusted inbound address (D25/D31). Fully idempotent:
 * an existing shop is reused (never duplicated), the inbound address is set to the same deterministic value
 * each run, and NO credentials are issued or rotated and NO orders are touched — so it is safe to run on
 * every api boot (step 5, right after the catalog seed). API-key issuance stays in `scripts/provision.ts`
 * (plaintext shown once), which reuses this function.
 *
 * `inboundDomain` is the Resend receiving domain for `<slug>@<domain>` routing; when null, shops are still
 * created but left WITHOUT an inbound address (email-by-address routing off until configured; D31 generic
 * content routing and the web form are unaffected).
 */
export async function provisionDefaultShops(
  shops: ShopsService,
  opts: { inboundDomain: string | null },
): Promise<ProvisionResult[]> {
  const domain = opts.inboundDomain?.trim() || null;
  const out: ProvisionResult[] = [];
  for (const slug of DEFAULT_SHOP_SLUGS) {
    let created = false;
    try {
      await shops.createShop({ slug, timeZone: DEFAULT_TZ });
      created = true;
    } catch (err) {
      if (!(err instanceof ShopSlugTaken)) throw err; // already exists → reuse (idempotent)
    }
    const inboundAddress = domain ? `${slug}@${domain}` : null;
    await shops.setInboundAddress(slug, inboundAddress); // idempotent: same value each run
    out.push({ slug, created, inboundAddress });
  }
  return out;
}
