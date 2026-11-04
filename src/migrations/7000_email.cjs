/* eslint-disable */
// Slice 006: email. Outbound clarification questions via a transactional outbox (reuses the outbox
// pattern); inbound replies de-duplicated by provider Message-ID. Shop-owned, forced RLS, composite FKs.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE email_outbox (
      id                  uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id             uuid NOT NULL,
      request_id          uuid NOT NULL,
      to_email            text NOT NULL,
      subject             text NOT NULL,
      body                text NOT NULL,
      status              text NOT NULL DEFAULT 'pending',   -- pending | sent | failed
      provider_message_id text,
      error               text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      sent_at             timestamptz,
      PRIMARY KEY (id),
      CONSTRAINT email_outbox_request_uniq UNIQUE (request_id),  -- one follow-up email per request (I6-aligned)
      CONSTRAINT email_outbox_status_chk CHECK (status IN ('pending','sent','failed')),
      CONSTRAINT email_outbox_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );

    -- Inbound reply de-duplication keyed by the provider Message-ID (per shop).
    CREATE TABLE inbound_emails (
      id                  uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id             uuid NOT NULL,
      request_id          uuid NOT NULL,
      provider_message_id text NOT NULL,
      received_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT inbound_emails_dedupe_uniq UNIQUE (shop_id, provider_message_id),
      CONSTRAINT inbound_emails_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_outbox, inbound_emails TO app_user, app_admin;

    ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
    ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY; ALTER TABLE inbound_emails FORCE ROW LEVEL SECURITY;

    CREATE POLICY email_outbox_tenant ON email_outbox FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY inbound_emails_tenant ON inbound_emails FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY email_outbox_admin ON email_outbox FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY inbound_emails_admin ON inbound_emails FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS inbound_emails; DROP TABLE IF EXISTS email_outbox;`);
};
