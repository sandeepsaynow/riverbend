/**
 * Local provisioning (009 FR-008): ensure the three assignment shops exist and issue a shop API key
 * per shop — no manual SQL. Idempotent: an existing ACTIVE key is NEVER silently rotated; it is
 * reported (masked) and left alone. Pass --rotate to issue a replacement on purpose.
 *
 * Run against a RUNNING stack (`make up`): `make provision` (reads DATABASE_ADMIN_URL, default localhost).
 * Plaintext keys are printed ONCE here — copy them now; they are not retrievable later.
 */
import { Db } from '../src/platform/db/index.js';
import { ShopsService, ShopSlugTaken } from '../src/modules/shops/index.js';
import { AuthService } from '../src/modules/auth/index.js';

const SHOPS = ['rb-downtown', 'rb-northside', 'rb-lakeshore'];
const SCOPES = ['intake:write', 'requests:read', 'orders:read', 'catalog:read', 'shop:read'];
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgres://app_admin:admin_pw@localhost:5432/riverbend';

async function main(): Promise<void> {
  const rotate = process.argv.includes('--rotate');
  const db = new Db({ appUrl: ADMIN_URL, adminUrl: ADMIN_URL });
  const shops = new ShopsService(db);
  const auth = new AuthService(db);

  console.log(`Provisioning ${SHOPS.length} shops${rotate ? ' (--rotate: will issue new keys)' : ''}…\n`);
  for (const slug of SHOPS) {
    try {
      await shops.createShop({ slug, timeZone: 'America/Chicago' });
      console.log(`  ${slug}: shop created`);
    } catch (err) {
      if (err instanceof ShopSlugTaken) console.log(`  ${slug}: shop exists (reused)`);
      else throw err;
    }
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
