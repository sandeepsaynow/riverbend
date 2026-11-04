/* eslint-disable */
// Slice 010 fix (D20.2): defense-in-depth DB constraint — a COMPLETED bootstrap marker must always carry a
// recorded admin user id. This makes the state-machine invariant (completion ⟺ admin_user_id IS NOT NULL)
// enforceable by PostgreSQL, so no code path can mark the single-use bootstrap "completed" without a real,
// bootstrap-created administrator. Additive; appended after 12000 (new migrations never precede applied ones).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE auth_bootstrap
      ADD CONSTRAINT auth_bootstrap_complete_has_admin
      CHECK (status <> 'completed' OR admin_user_id IS NOT NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE auth_bootstrap DROP CONSTRAINT IF EXISTS auth_bootstrap_complete_has_admin;`);
};
