/* eslint-disable */
// Slice 004: work orders + line items. One order per (shop, request, bike) — unique key = I2.
// Line prices computed in code and SNAPSHOTTED (unit price + catalog version) so later catalog
// changes never rewrite history (D8/I5). Shop-owned, forced RLS, composite FKs (D2).
exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  pgm.sql(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'ordered'`);
  pgm.sql(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'cancelled'`);

  pgm.sql(`
    CREATE TYPE work_order_status AS ENUM ('open', 'cancelled');

    CREATE TABLE work_orders (
      id          uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id     uuid NOT NULL,
      request_id  uuid NOT NULL,
      bike_number integer NOT NULL,
      status      work_order_status NOT NULL DEFAULT 'open',
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT work_orders_one_per_bike UNIQUE (shop_id, request_id, bike_number),  -- I2
      CONSTRAINT work_orders_id_shop_uniq UNIQUE (id, shop_id),
      CONSTRAINT work_orders_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );

    CREATE TABLE work_order_items (
      id                  uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id             uuid NOT NULL,
      order_id            uuid NOT NULL,
      code                text NOT NULL,
      name                text NOT NULL,
      unit_price_cents    integer NOT NULL CHECK (unit_price_cents >= 0),  -- snapshot (I5)
      quantity            integer NOT NULL CHECK (quantity > 0),
      line_total_cents    integer NOT NULL CHECK (line_total_cents >= 0), -- unit * quantity, in code
      catalog_version     text NOT NULL,                                  -- snapshot
      requires_inspection boolean NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT work_order_items_order_fk FOREIGN KEY (order_id, shop_id)
        REFERENCES work_orders (id, shop_id) ON DELETE CASCADE
    );
    CREATE INDEX work_order_items_order_idx ON work_order_items (order_id);

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE work_orders, work_order_items TO app_user, app_admin;

    ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE work_orders FORCE ROW LEVEL SECURITY;
    ALTER TABLE work_order_items ENABLE ROW LEVEL SECURITY; ALTER TABLE work_order_items FORCE ROW LEVEL SECURITY;

    CREATE POLICY work_orders_tenant ON work_orders FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY work_order_items_tenant ON work_order_items FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY work_orders_admin ON work_orders FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY work_order_items_admin ON work_order_items FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS work_order_items; DROP TABLE IF EXISTS work_orders; DROP TYPE IF EXISTS work_order_status;`);
};
