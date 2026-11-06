/**
 * Local provisioning (009 FR-008): ensure the three assignment shops exist and issue a shop API key
 * per shop — no manual SQL. Idempotent: an existing ACTIVE key is NEVER silently rotated; it is
 * reported (masked) and left alone. Pass --rotate to issue a replacement on purpose.
 *
 * Run against a RUNNING stack (`make up`): `make provision` (reads DATABASE_ADMIN_URL, default localhost).
 * Plaintext keys are printed ONCE here — copy them now; they are not retrievable later.
 */
import { Db } from '../src/platform/db/index.js';
import { ShopsService } from '../src/modules/shops/index.js';
import { provisionDefaultShops, DEFAULT_SHOP_SLUGS } from '../src/modules/shops/provision.js';
import { AuthService } from '../src/modules/auth/index.js';

const SHOPS = [...DEFAULT_SHOP_SLUGS];
const SCOPES = ['intake:write', 'requests:read', 'orders:read', 'catalog:read', 'shop:read'];
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgres://app_admin:admin_pw@localhost:5432/riverbend';
// Trusted inbound-email routing (D25): one receiving address per shop. For a real deployment set
// RESEND_INBOUND_DOMAIN to your VERIFIED Resend receiving domain; locally a placeholder is fine.
const INBOUND_DOMAIN = process.env.RESEND_INBOUND_DOMAIN ?? process.env.RESEND_REPLY_DOMAIN ?? 'inbound.localhost';

async function main(): Promise<void> {
  const rotate = process.argv.includes('--rotate');
  const db = new Db({ appUrl: ADMIN_URL, adminUrl: ADMIN_URL });
  const shops = new ShopsService(db);
  const auth = new AuthService(db);

  console.log(`Provisioning ${SHOPS.length} shops${rotate ? ' (--rotate: will issue new keys)' : ''}…\n`);
  // Shops + inbound addresses via the SAME idempotent helper the api runs on boot (no drift).
  const provisioned = await provisionDefaultShops(shops, { inboundDomain: INBOUND_DOMAIN });
  for (const p of provisioned) {
    console.log(`  ${p.slug}: shop ${p.created ? 'created' : 'exists (reused)'}`);
    console.log(`  ${p.slug}: inbound address → ${p.inboundAddress ?? '(none)'}`);
  }
  // Then issue one shop API key each (plaintext shown ONCE; an existing active key is never rotated).
  for (const slug of SHOPS) {
    const existing = (await auth.listShopCredentials(slug)).filter((c) => c.kind === 'shop' && c.status === 'active');
    if (existing.length > 0 && !rotate) {
      console.log(`  ${slug}: active key already present (prefix ${existing[0]!.prefix}…) — NOT rotating. Use \`make provision ROTATE=1\` to replace.\n`);
      continue;
    }
    const issued = await auth.issueShopCredential(slug, { name: 'local-demo', scopes: SCOPES });
    console.log(`  ${slug}: NEW KEY (copy now, shown once) →  ${issued.token}\n`);
  }
  await db.close();
  console.log('Done. Use a key as:  Authorization: Bearer <key>');
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
