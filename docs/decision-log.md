# Decision Log

Constitution amendments (per Governance): each entry states the change, rationale, and version bump.

## 2026-11-04 — Constitution 1.1.0 → 1.2.0 (MINOR): I4 enforcement moved to LiteLLM-native budgets

**Change.** Invariant I4's enforcement mechanism and proof are redefined from Riverbend's custom
reserve-then-settle ledger to **LiteLLM-native budgets** (one team per shop, restricted virtual keys,
fail-closed admission, proxy-calculated cost capture). I4's guarantee — "AI spend never exceeds a
shop's monthly cap" — is **unchanged**. Decision D7 in `docs/ARCHITECTURE_DECISIONS.md` is updated
(Hybrid-ledger-authority → LiteLLM-native-authority) and Feature 003 FR-007/FR-008 are rewritten.

**Rationale.** D7 originally rejected "LiteLLM alone" for four reasons; LiteLLM 1.106.6 resolves two
(reservation-based budgets + fail-closed enforcement now exist), and two are handled by design:
calendar-month reset is administered by Riverbend (business policy), and a request-scoped usage record
(not a competing reservation engine) preserves no-double-charge on redelivery. This removes the second
competing budget engine while keeping Riverbend authoritative for tenant identity, `held_budget`, and
request-level cost references.

**Bump.** MINOR (1.2.0): a mechanism/proof redefinition with the guarantee intact; no principle or
invariant guarantee removed. MAJOR was considered (mechanism of a NON-NEGOTIABLE invariant) and
rejected because the safety guarantee is preserved.

**Safety.** The legacy `BudgetService` path is retained behind a flag for rollback; native enforcement
becomes the sole authority only after the FR-007 acceptance tests pass (zero-cost rejection/mocks; no
paid budget-exhaustion tests).
