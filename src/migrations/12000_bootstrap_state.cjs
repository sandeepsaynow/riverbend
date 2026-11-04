/* eslint-disable */
// Slice 010 fix (D20.1): make first-admin bootstrap a recoverable two-phase marker. The prior design
// (10000) treated ANY auth_bootstrap row as "initialized", so a crash/error between the marker INSERT
// and the admin creation left a row with admin_user_id = NULL → permanent 409 lockout with no usable
// admin. We add:
//   - admin_email: binds a PENDING init to one email so retries can't create a *second* admin.
//   - status: explicit pending|completed (mirrors the hard invariant admin_user_id IS NOT NULL).
// Completion is authoritatively `admin_user_id IS NOT NULL`; `status` is the human-readable mirror.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE auth_bootstrap ADD COLUMN IF NOT EXISTS admin_email text;
    ALTER TABLE auth_bootstrap ADD COLUMN IF NOT EXISTS status text;
    -- Backfill: a pre-existing marker is "completed" only if it actually recorded an admin; an orphaned
    -- marker from a failed init (admin_user_id NULL) is correctly reclassified "pending" (retryable).
    UPDATE auth_bootstrap SET status = CASE WHEN admin_user_id IS NOT NULL THEN 'completed' ELSE 'pending' END WHERE status IS NULL;
    ALTER TABLE auth_bootstrap ALTER COLUMN status SET DEFAULT 'pending';
    ALTER TABLE auth_bootstrap ALTER COLUMN status SET NOT NULL;
    ALTER TABLE auth_bootstrap ADD CONSTRAINT auth_bootstrap_status_ck CHECK (status IN ('pending','completed'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE auth_bootstrap DROP CONSTRAINT IF EXISTS auth_bootstrap_status_ck;
    ALTER TABLE auth_bootstrap DROP COLUMN IF EXISTS status;
    ALTER TABLE auth_bootstrap DROP COLUMN IF EXISTS admin_email;
  `);
};
