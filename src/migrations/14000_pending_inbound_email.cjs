/* eslint-disable */
// Slice 006 extension (D32): pre-tenant pending-intake for a generic inbound email whose shop could NOT be
// resolved from content (missing / ambiguous / contradictory). The email must not be dropped and must not be
// attributed to a tenant until the customer confirms which shop — but no tenant exists yet, so it cannot live
// in a shop-owned (RLS) table. This is a SYSTEM triage table with NO shop_id: it holds only the customer's
// OWN message pre-routing (no shop-owned rows), so forced RLS does not apply and nothing cross-tenant can
// leak. Once the shop is resolved, a normal tenant-scoped request is created from the stored body and this
// row is marked resolved (audit trail). Additive; appended after 13000.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS pending_inbound_email (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_message_id text NOT NULL,              -- de-dup: a provider retry/overlap is one pending row
      from_email          text,                       -- the reply path (clarification recipient); never routing
      subject             text,
      body                text NOT NULL,              -- the original message, replayed into intake on resolution
      state               text NOT NULL DEFAULT 'awaiting_shop',  -- awaiting_shop | resolved | abandoned
      reason              text,                        -- why unresolved: 'no_shop' | 'ambiguous_shop'
      clarify_sent        boolean NOT NULL DEFAULT false,  -- bounded: exactly one clarification per pending row
      attempts            integer NOT NULL DEFAULT 0,
      resolved_shop_id    uuid,                        -- audit: which shop it resolved to
      resolved_request_id uuid,                        -- audit: the created request
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_inbound_email_provider_uniq ON pending_inbound_email (provider_message_id);
    CREATE INDEX IF NOT EXISTS pending_inbound_email_awaiting_idx ON pending_inbound_email (state) WHERE state = 'awaiting_shop';
    -- Accessed by the worker/email service via the admin role (no tenant; this is a system triage table).
    -- No RLS: the table has no shop_id, so forced-RLS does not apply; ordinary grants gate access.
    GRANT SELECT, INSERT, UPDATE ON pending_inbound_email TO app_admin, app_user;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS pending_inbound_email;`);
};
