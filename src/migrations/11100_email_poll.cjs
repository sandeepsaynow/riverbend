/* eslint-disable */
// Slice 006 polling extension (D21.1): local/MVP inbound by Resend Receiving-API polling. A single-row
// checkpoint + lease. GLOBAL (no shop_id, no PII) — same class as email_events / Better-Auth tables, so
// outside the shop_id→forced-RLS policy-check. Discovery itself reuses email_events (svix_id = poll:<id>).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE email_poll_state (
      id              bool NOT NULL DEFAULT true,
      last_created_at timestamptz,
      last_email_id   text,
      claimed_until   timestamptz,       -- single-flight lease; a second poller finds it claimed and no-ops
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT email_poll_state_singleton CHECK (id = true)
    );
    INSERT INTO email_poll_state (id) VALUES (true) ON CONFLICT DO NOTHING;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_poll_state TO app_admin;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS email_poll_state;`);
};
