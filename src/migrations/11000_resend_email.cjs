/* eslint-disable */
// Slice 006 amendment (D21): Resend as the sole email provider. Additive — the original 7000_email.cjs
// (email_outbox / inbound_emails, forced RLS) is unchanged. Adds outbound html + idempotency + bounded
// retry + delivery-status columns, and a durable provider-event ingestion log (email_events).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Outbound: HTML alternative, provider idempotency key, bounded retry, and delivery lifecycle.
    ALTER TABLE email_outbox
      ADD COLUMN html            text,
      ADD COLUMN idempotency_key text,
      ADD COLUMN attempts        int NOT NULL DEFAULT 0,
      ADD COLUMN next_attempt_at timestamptz,
      ADD COLUMN delivery_status text,                 -- sent | delivered | bounced | failed | delayed
      ADD COLUMN delivered_at    timestamptz,
      ADD COLUMN failure_reason  text;

    -- Durable provider-event ingestion (D21/FR-011,FR-012). GLOBAL: the owning shop is unknown until the
    -- content is fetched + the signed token verified, so this log has NO shop_id and stores NO address/
    -- subject/body (VII). It is therefore outside the shop_id→forced-RLS policy-check (same deviation
    -- class as the Better-Auth identity tables, D20). De-duped by the Svix delivery id (reused on retries).
    CREATE TABLE email_events (
      id              uuid NOT NULL DEFAULT gen_random_uuid(),
      svix_id         text NOT NULL,
      event_type      text NOT NULL,
      resend_email_id text,
      status          text NOT NULL DEFAULT 'pending',  -- pending | processed | ignored | error
      attempts        int  NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now(),
      processed_at    timestamptz,
      detail          text,
      PRIMARY KEY (id),
      CONSTRAINT email_events_svix_uniq UNIQUE (svix_id),
      CONSTRAINT email_events_status_chk CHECK (status IN ('pending','processed','ignored','error'))
    );
    -- Worker processes events on the admin (cross-shop) connection, as the outbox relay already does.
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_events TO app_admin;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS email_events;
    ALTER TABLE email_outbox
      DROP COLUMN IF EXISTS html,
      DROP COLUMN IF EXISTS idempotency_key,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS delivery_status,
      DROP COLUMN IF EXISTS delivered_at,
      DROP COLUMN IF EXISTS failure_reason;
  `);
};
