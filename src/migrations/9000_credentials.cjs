/* eslint-disable */
// Slice 009: credential lifecycle — name, scopes, expiry on credentials; an ids-only audit log.
// Backward-compatible: existing credentials get scopes '{}' (treated as UNRESTRICTED by requireScope)
// and NULL expiry (never expires), so current behavior is unchanged.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS name       text;
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS scopes     text[] NOT NULL DEFAULT '{}';
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS expires_at timestamptz;

    -- Credential lifecycle audit (issue / revoke / rotate). Ids + event only — never a secret (VII).
    CREATE TABLE credential_audit (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credential_id uuid NOT NULL,
      shop_id       uuid,                 -- null for admin/bootstrap credential events
      event         text NOT NULL,        -- issued | revoked | rotated
      detail        text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT credential_audit_event_ck CHECK (event IN ('issued','revoked','rotated'))
    );
    CREATE INDEX credential_audit_cred_idx ON credential_audit (credential_id);
    CREATE INDEX credential_audit_shop_idx ON credential_audit (shop_id);

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE credential_audit TO app_user, app_admin;
    -- Has a shop_id column → forced RLS + policies required by the isolation build/readiness check.
    ALTER TABLE credential_audit ENABLE ROW LEVEL SECURITY; ALTER TABLE credential_audit FORCE ROW LEVEL SECURITY;
    CREATE POLICY credential_audit_tenant ON credential_audit FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY credential_audit_admin ON credential_audit FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS credential_audit;
    ALTER TABLE credentials DROP COLUMN IF EXISTS name;
    ALTER TABLE credentials DROP COLUMN IF EXISTS scopes;
    ALTER TABLE credentials DROP COLUMN IF EXISTS expires_at;
  `);
};
