/* eslint-disable */
// Shared, versioned service catalog (US5). Not shop-owned (no shop_id) => no RLS; readable by
// any authenticated shop. `code` is unique within a catalog version (FR-016).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE catalog_service (
      catalog_version     text NOT NULL,
      code                text NOT NULL,
      name                text NOT NULL,
      price_cents         integer NOT NULL CHECK (price_cents >= 0),
      minutes             integer NOT NULL CHECK (minutes >= 0),
      requires_inspection boolean NOT NULL,
      PRIMARY KEY (catalog_version, code)
    );
    GRANT SELECT ON TABLE catalog_service TO app_user, app_admin;
    GRANT INSERT, UPDATE, DELETE ON TABLE catalog_service TO app_admin;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS catalog_service;`);
};
