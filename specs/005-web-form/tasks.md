
## Phase — Operation-id lifecycle (D24)
- [x] T-W1 Form script mints a fresh UUID per load (no localStorage reuse) + regenerates on BFCache restore.
- [x] T-W2 Post/Redirect/Get on success (303 → status); status page links back to a fresh form.
- [x] T-W3 Input-preserving re-render on recoverable validation errors (fresh token + fresh id).
- [x] T-W4 tests/integration/web-idempotency.test.ts (7, persistent agent) + web.test PRG update. Live-verified.
