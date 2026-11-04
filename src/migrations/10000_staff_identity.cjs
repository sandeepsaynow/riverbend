/* eslint-disable */
// Slice 010 (foundation): Riverbend-side identity binding for the staff portal. Better Auth will own
// the `user`/`session`/`account` tables (in a dedicated `auth` schema, added by a later reviewed
// migration generated from the library). This migration adds ONLY Riverbend's authorization tables:
//   - shop_membership: binds a Better Auth user id → shop + role + active/disabled status (the tenant
//     authority for the portal; never a client-supplied shop_id).
//   - auth_bootstrap: a single-row marker enforcing one-time first-admin initialization.
// Build stays green with no Better Auth dependency yet (see specs/010-staff-auth-portal/tasks.md).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE shop_membership (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    text NOT NULL,                 -- Better Auth user id (string)
      shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      role       text NOT NULL DEFAULT 'SHOP_STAFF',
      status     text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT shop_membership_role_ck   CHECK (role IN ('PLATFORM_ADMIN','SHOP_ADMIN','SHOP_STAFF')),
      CONSTRAINT shop_membership_status_ck CHECK (status IN ('active','disabled')),
      CONSTRAINT shop_membership_uniq      UNIQUE (user_id, shop_id)
    );
    CREATE INDEX shop_membership_user_idx ON shop_membership (user_id);

    -- Single-use first-admin init marker: the CHECK pins id=true so at most one row can ever exist.
    CREATE TABLE auth_bootstrap (
      id             boolean PRIMARY KEY DEFAULT true,
      initialized_at timestamptz NOT NULL DEFAULT now(),
      admin_user_id  text,
      CONSTRAINT auth_bootstrap_singleton CHECK (id = true)
    );

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE shop_membership, auth_bootstrap TO app_user, app_admin;

    -- shop_membership has shop_id → forced RLS + policies required by the isolation build/readiness check.
    -- Identity resolution (find a user's shops) runs as app_admin (permissive), like the auth path.
    ALTER TABLE shop_membership ENABLE ROW LEVEL SECURITY; ALTER TABLE shop_membership FORCE ROW LEVEL SECURITY;
    CREATE POLICY shop_membership_tenant ON shop_membership FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY shop_membership_admin ON shop_membership FOR ALL TO app_admin USING (true) WITH CHECK (true);
    -- auth_bootstrap has no shop_id (global); not under tenant RLS by design.
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS shop_membership; DROP TABLE IF EXISTS auth_bootstrap;`);
};
