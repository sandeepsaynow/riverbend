/* eslint-disable */
// Slice 006 extension (D25): trusted inbound-email routing. A brand-NEW customer email (no reply token)
// must be attributed to a shop by its VERIFIED destination address — never by the sender's text (FR-013).
// `shops.inbound_address` is that explicit mapping: one address per shop, case-insensitively unique, set by
// provisioning/ops (not customer-controlled). Nullable so existing shops and keyless/offline runs are
// unaffected. Additive; appended after 12100 (new migrations never precede applied ones).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS inbound_address text;
    -- Case-insensitive uniqueness: two shops can never share a receiving address (would break tenant
    -- attribution). Partial so multiple shops may have NULL (no inbound address configured yet).
    CREATE UNIQUE INDEX IF NOT EXISTS shops_inbound_address_uniq
      ON shops (lower(inbound_address)) WHERE inbound_address IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS shops_inbound_address_uniq;
    ALTER TABLE shops DROP COLUMN IF EXISTS inbound_address;
  `);
};
