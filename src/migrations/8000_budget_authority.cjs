/* eslint-disable */
// Budget authority migration (constitution 2.0.0): LiteLLM-native budgets become the sole active
// authority. Maps each shop to its LiteLLM team + restricted virtual key (the worker selects the key
// server-side). Adds accounting columns to llm_calls (proxy-calculated cost, model, tokens, request id).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE shop_llm_identity (
      shop_id       uuid NOT NULL,
      team_id       text NOT NULL,
      virtual_key   text NOT NULL,          -- restricted LiteLLM key for this shop (NOT the master key)
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (shop_id),
      CONSTRAINT shop_llm_identity_shop_fk FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE shop_llm_identity TO app_user, app_admin;
    ALTER TABLE shop_llm_identity ENABLE ROW LEVEL SECURITY; ALTER TABLE shop_llm_identity FORCE ROW LEVEL SECURITY;
    CREATE POLICY shop_llm_identity_tenant ON shop_llm_identity FOR ALL TO app_user
      USING (shop_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (shop_id::text = current_setting('app.tenant_id', true));
    CREATE POLICY shop_llm_identity_admin ON shop_llm_identity FOR ALL TO app_admin USING (true) WITH CHECK (true);

    -- Accounting (not reservation): proxy-calculated cost + usage recorded per call. cost_source tells
    -- proxy-calculated from provider-billed apart (IX).
    ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS model               text;
    ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS prompt_tokens       integer;
    ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS completion_tokens   integer;
    ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS provider_request_id text;
    ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_source         text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS shop_llm_identity;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS model;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS prompt_tokens;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS completion_tokens;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS provider_request_id;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS cost_source;
  `);
};
