/* eslint-disable */
// Slice 003 (part 1): per-shop AI spend ledger (I4) + model-call receipts (replay-safe, no double
// charge). Money/spend in whole millionths of a dollar (micros), per D8. Shop-owned, forced RLS.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE llm_call_status AS ENUM ('reserved', 'settled', 'failed');

    -- Per-shop, per-period (YYYY-MM) budget. The reserve-then-settle authority (I4).
    CREATE TABLE shop_budgets (
      shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      period          text NOT NULL,                       -- e.g. '2026-09' (shop-local calendar month)
      cap_micros      bigint NOT NULL CHECK (cap_micros >= 0),
      spent_micros    bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
      reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
      PRIMARY KEY (shop_id, period)
    );

    -- One receipt per (request, step, attempt): a replayed/crashed job reuses it → never charged twice.
    CREATE TABLE llm_calls (
      id              uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id         uuid NOT NULL,
      request_id      uuid NOT NULL,
      period          text NOT NULL,
      step            text NOT NULL,
      attempt         integer NOT NULL,
      estimate_micros bigint NOT NULL CHECK (estimate_micros >= 0),
      cost_micros     bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
      status          llm_call_status NOT NULL DEFAULT 'reserved',
      created_at      timestamptz NOT NULL DEFAULT now(),
      settled_at      timestamptz,
      PRIMARY KEY (id),
      CONSTRAINT llm_calls_receipt_uniq UNIQUE (shop_id, request_id, step, attempt),
      -- composite FK: the request must belong to the SAME shop (D2).
      CONSTRAINT llm_calls_request_fk FOREIGN KEY (request_id, shop_id)
        REFERENCES requests (id, shop_id) ON DELETE CASCADE
    );
    CREATE INDEX llm_calls_reserved_idx ON llm_calls (status) WHERE status = 'reserved';

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE shop_budgets, llm_calls TO app_user, app_admin;

    ALTER TABLE shop_budgets ENABLE ROW LEVEL SECURITY;  ALTER TABLE shop_budgets FORCE ROW LEVEL SECURITY;
    ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;     ALTER TABLE llm_calls FORCE ROW LEVEL SECURITY;

    CREATE POLICY shop_budgets_tenant ON shop_budgets FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY llm_calls_tenant ON llm_calls FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY shop_budgets_admin ON shop_budgets FOR ALL TO app_admin USING (true) WITH CHECK (true);
    CREATE POLICY llm_calls_admin ON llm_calls FOR ALL TO app_admin USING (true) WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS llm_calls;
    DROP TABLE IF EXISTS shop_budgets;
    DROP TYPE IF EXISTS llm_call_status;
  `);
};
