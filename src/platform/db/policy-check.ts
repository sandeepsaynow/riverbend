import type { Db } from './index.js';

export interface PolicyGap {
  table: string;
  reason: 'rls_not_enabled' | 'rls_not_forced' | 'no_policy';
}

/**
 * Inspect the database's own catalog to confirm every shop-owned (`shop_id`) table has
 * row-level security ENABLED and FORCED and at least one policy (FR-004 build-time check and
 * FR-013(c) runtime readiness check — same probe, two callers). Returns the gaps found.
 *
 * `shop_id` is our tenant marker. Shared reference data (catalog) has no `shop_id` and is skipped.
 */
export async function findPolicyGaps(db: Db): Promise<PolicyGap[]> {
  // Discover via pg_catalog (visible to every role regardless of table privileges) so the audit
  // sees ALL shop-owned tables, not only those the querying role can access.
  const tables = await db.adminQuery<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attname = 'shop_id'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
  );

  const gaps: PolicyGap[] = [];
  for (const { table_name } of tables.rows) {
    const meta = await db.adminQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE oid = to_regclass($1)`,
      [`public.${table_name}`],
    );
    const row = meta.rows[0];
    if (!row || !row.relrowsecurity) {
      gaps.push({ table: table_name, reason: 'rls_not_enabled' });
      continue;
    }
    if (!row.relforcerowsecurity) {
      gaps.push({ table: table_name, reason: 'rls_not_forced' });
      continue;
    }
    const pol = await db.adminQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
      [table_name],
    );
    if (Number(pol.rows[0]?.count ?? '0') === 0) {
      gaps.push({ table: table_name, reason: 'no_policy' });
    }
  }
  return gaps;
}
