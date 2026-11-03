/* eslint-disable */
// Slice 003 (part 2): persisted validated extraction + the single follow-up question (I6). New
// request states for pipeline outcomes. Shop-owned, forced RLS, composite FKs to requests (D2).
// noTransaction: ALTER TYPE ... ADD VALUE must not run inside a transaction that also uses the value.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  pgm.sql(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'extracted'`);
  pgm.sql(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'answered'`);
  pgm.sql(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'awaiting_customer'`);
  pgm.sql(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'held_budget'`);

  pgm.sql(`
    CREATE TABLE extractions (
      id          uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id     uuid NOT NULL,
      request_id  uuid NOT NULL,
      kind        text NOT NULL,
      bikes       jsonb NOT NULL,
      urgency     text NOT NULL,
      date_words  text,
      flagged     boolean NOT NULL DEFAULT false,
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT extractions_request_uniq UNIQUE (request_id),
      CONSTRAINT extractions_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );

    -- At most ONE follow-up per request (I6) — enforced by the UNIQUE on request_id.
    CREATE TABLE follow_ups (
      id            uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id       uuid NOT NULL,
      request_id    uuid NOT NULL,
      question      text NOT NULL,
      asked_at      timestamptz NOT NULL DEFAULT now(),
      reply_content text,
      replied_at    timestamptz,
      PRIMARY KEY (id),
      CONSTRAINT follow_ups_request_uniq UNIQUE (request_id),
      CONSTRAINT follow_ups_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE extractions, follow_ups TO app_user, app_admin;

    ALTER TABLE extractions ENABLE ROW LEVEL SECURITY; ALTER TABLE extractions FORCE ROW LEVEL SECURITY;
    ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;  ALTER TABLE follow_ups FORCE ROW LEVEL SECURITY;

    CREATE POLICY extractions_tenant ON extractions FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY follow_ups_tenant ON follow_ups FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY extractions_admin ON extractions FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY follow_ups_admin ON follow_ups FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS follow_ups; DROP TABLE IF EXISTS extractions;`);
  // enum values are not removed (Postgres cannot drop enum values); harmless if unused.
};
