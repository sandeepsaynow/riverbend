/* eslint-disable */
// Slice 001 initial schema: shops + credentials, with forced row-level security (D2, I1).
// Roles app_user (NOBYPASSRLS, tenant-scoped) and app_admin (NOBYPASSRLS, cross-shop) are
// provisioned by infrastructure (docker-compose init / test harness) before migrations run.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Runtime roles may read the migrations ledger (readiness / schema-state checks, FR-013).
    GRANT SELECT ON TABLE pgmigrations TO app_user, app_admin;

    CREATE TYPE credential_kind AS ENUM ('shop', 'admin');
    CREATE TYPE credential_status AS ENUM ('active', 'revoked');

    -- The tenant. A shop belongs to itself (RLS on shops compares id to app.tenant_id).
    CREATE TABLE shops (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
      time_zone    text NOT NULL,
      display_name text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Authenticating secrets. kind='shop' carries the tenant; kind='admin' is not shop-bound.
    CREATE TABLE credentials (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind               credential_kind NOT NULL,
      shop_id            uuid REFERENCES shops(id) ON DELETE CASCADE,
      prefix             text NOT NULL,
      secret_fingerprint bytea NOT NULL,
      status             credential_status NOT NULL DEFAULT 'active',
      last_used_at       timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      revoked_at         timestamptz,
      CONSTRAINT credentials_kind_shop_ck CHECK (
        (kind = 'shop' AND shop_id IS NOT NULL) OR (kind = 'admin' AND shop_id IS NULL)
      ),
      CONSTRAINT credentials_kind_prefix_uniq UNIQUE (kind, prefix)
    );
    CREATE INDEX credentials_shop_idx ON credentials (shop_id);

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE shops TO app_user, app_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE credentials TO app_user, app_admin;

    -- Forced RLS: applies even to the table owner; app_user has NO BYPASSRLS (I1).
    ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
    ALTER TABLE shops FORCE ROW LEVEL SECURITY;
    ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE credentials FORCE ROW LEVEL SECURITY;

    -- app_user: strictly tenant-scoped. Unset tenant => current_setting(...,true) IS NULL => no rows.
    CREATE POLICY shops_tenant ON shops FOR ALL TO app_user
      USING (id::text = current_setting('app.tenant_id', true))
      WITH CHECK (id::text = current_setting('app.tenant_id', true));
    CREATE POLICY credentials_tenant ON credentials FOR ALL TO app_user
      USING (kind = 'shop' AND shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (kind = 'shop' AND shop_id::text = current_setting('app.tenant_id', true));

    -- app_admin: cross-shop, for provisioning + credential lookup (documented exception, D2).
    CREATE POLICY shops_admin ON shops FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY credentials_admin ON credentials FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS credentials;
    DROP TABLE IF EXISTS shops;
    DROP TYPE IF EXISTS credential_status;
    DROP TYPE IF EXISTS credential_kind;
  `);
};
