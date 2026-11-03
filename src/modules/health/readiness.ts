import type { Db } from '../../platform/db/index.js';
import { schemaState } from '../../platform/db/migrate.js';
import { findPolicyGaps } from '../../platform/db/policy-check.js';

export type ReadinessReason =
  | 'db_unreachable'
  | 'migrations_pending'
  | 'schema_incompatible'
  | 'security_policy_missing';

export interface ReadinessResult {
  ready: boolean;
  reasons: ReadinessReason[];
}

/**
 * Readiness (FR-013). Ready only when ALL hold: (a) data store reachable; (b) migrations applied
 * and schema compatible; (c) shop-isolation policies present and forced. Configuration is NOT
 * checked here — it is validated once at startup (FR-014). Independent of liveness.
 */
export async function checkReadiness(db: Db, schemaUrl: string): Promise<ReadinessResult> {
  const reasons: ReadinessReason[] = [];

  // (a) reachability — if the store is down, nothing else can be checked.
  try {
    await db.adminQuery('SELECT 1');
  } catch {
    return { ready: false, reasons: ['db_unreachable'] };
  }

  // (b) migrations applied / schema compatible.
  try {
    const state = await schemaState(schemaUrl);
    if (state.pending.length > 0) reasons.push('migrations_pending');
    if (state.unknown.length > 0) reasons.push('schema_incompatible');
  } catch {
    reasons.push('migrations_pending');
  }

  // (c) shop-isolation policies present and forced on every tenant table (runtime catalog probe).
  try {
    const gaps = await findPolicyGaps(db);
    if (gaps.length > 0) reasons.push('security_policy_missing');
  } catch {
    reasons.push('security_policy_missing');
  }

  return { ready: reasons.length === 0, reasons };
}
