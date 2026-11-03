/* eslint-disable */
// Slice 002: intake + durable queue. Three shop-owned tables with forced RLS (D2/D3/D4).
// Composite foreign keys (the D2 convention, first real use here): a child row can never reference
// another shop's parent row. pg-boss owns its own `pgboss` schema (created by the adapter at startup).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE message_source AS ENUM ('email', 'web', 'api');
    CREATE TYPE request_state AS ENUM ('received', 'processing', 'awaiting_pipeline', 'needs_review');
    CREATE TYPE outbox_status AS ENUM ('pending', 'published');

    -- Inbound messages. Idempotency key: (shop_id, source, submission_id). First slice to store text.
    CREATE TABLE messages (
      id                  uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id             uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      source              message_source NOT NULL,
      submission_id       text NOT NULL,
      content             text NOT NULL,
      content_fingerprint bytea NOT NULL,
      received_at         timestamptz NOT NULL DEFAULT now(),
      created_at          timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT messages_idempotency_uniq UNIQUE (shop_id, source, submission_id),
      CONSTRAINT messages_id_shop_uniq UNIQUE (id, shop_id)
    );

    -- The unit of work; its id is the public tracking reference. One request per message.
    CREATE TABLE requests (
      id                    uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      message_id            uuid NOT NULL,
      state                 request_state NOT NULL DEFAULT 'received',
      attempts              integer NOT NULL DEFAULT 0,
      last_error            text,
      processing_started_at timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT requests_message_uniq UNIQUE (message_id),
      CONSTRAINT requests_id_shop_uniq UNIQUE (id, shop_id),
      -- composite FK: the message must belong to the SAME shop (D2).
      CONSTRAINT requests_message_fk FOREIGN KEY (message_id, shop_id)
        REFERENCES messages (id, shop_id) ON DELETE CASCADE
    );

    -- Durable job-intent written atomically with message+request; drained to pg-boss by the relay.
    CREATE TABLE job_outbox (
      id           uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      request_id   uuid NOT NULL,
      status       outbox_status NOT NULL DEFAULT 'pending',
      created_at   timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      PRIMARY KEY (id),
      -- composite FK: the request must belong to the SAME shop (D2).
      CONSTRAINT job_outbox_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );
    CREATE INDEX job_outbox_pending_idx ON job_outbox (status) WHERE status = 'pending';

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE messages, requests, job_outbox TO app_user, app_admin;

    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;  ALTER TABLE messages FORCE ROW LEVEL SECURITY;
    ALTER TABLE requests ENABLE ROW LEVEL SECURITY;  ALTER TABLE requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE job_outbox FORCE ROW LEVEL SECURITY;

    -- app_user: strictly tenant-scoped (unset tenant => NULL => no rows, fail-closed).
    CREATE POLICY messages_tenant ON messages FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY requests_tenant ON requests FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY job_outbox_tenant ON job_outbox FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));

    -- app_admin: cross-shop (relay/reconciler operate on ids only; documented D2 exception).
    CREATE POLICY messages_admin ON messages FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY requests_admin ON requests FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY job_outbox_admin ON job_outbox FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS job_outbox;
    DROP TABLE IF EXISTS requests;
    DROP TABLE IF EXISTS messages;
    DROP TYPE IF EXISTS outbox_status;
    DROP TYPE IF EXISTS request_state;
    DROP TYPE IF EXISTS message_source;
  `);
};
