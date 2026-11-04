/* eslint-disable */
// Slice 005: public web intake form. Captures the customer's reply path (email, I8) on the message.
// Nullable (api/email sources may omit it); the web layer enforces it as mandatory. Not logged (VII).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS customer_email text`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE messages DROP COLUMN IF EXISTS customer_email`);
};
