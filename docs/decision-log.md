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

## 2026-11-04 — Empirical finding: LiteLLM-native budgets are a SOFT cap (investigation, no paid calls)

Tested LiteLLM 1.106.6 + PostgreSQL with a **mock upstream provider + configured per-token pricing**
(zero paid OpenAI calls — this resolves the earlier "can't verify without paid calls" concern):

- ✅ `x-litellm-response-cost` + per-key spend tracked from a mock call; teams + virtual keys + 422
  `budget_exceeded` rejection all work; master key not needed for inference.
- ⚠️ **Enforcement is eventually-consistent:** team budget $0.04, $0.05/call → call 1 AND call 2 admitted
  (spend not yet flushed), call 3+ rejected. The cap can be exceeded by ~one in-flight call. Under
  10-way concurrency it was conservative (1/10 admitted). `budget_duration:"30d"` → reset_at = first of
  next month (calendar-aligned; to confirm before claiming).

**Consequence:** invariant **I4 ("AI spend never exceeds a shop's monthly cap")** is a HARD guarantee;
LiteLLM-native alone can only offer a bounded-overshoot SOFT cap. Making LiteLLM the **sole** authority
(removing Riverbend's atomic reserve-then-settle) would REGRESS I4. Per the standing rule to reject
approaches that violate an established invariant, the sole-authority cutover is **not** performed.

**Decision (reverts the 1.2.0 premise toward the original D7 defense-in-depth):** Riverbend's
reserve-then-settle remains the authoritative hard cap (meets I4); LiteLLM-native teams/keys/budgets
become the enforcement **backstop** (set above the Riverbend cap) + the real-cost **accounting** source
(already captured via `x-litellm-response-cost`). Recommend refining the 1.2.0 amendment / FR-007 wording
to match this measured reality (pending owner confirmation, since it touches a NON-NEGOTIABLE invariant).

## 2026-11-04 — Constitution 1.2.0 → 2.0.0 (MAJOR): I4 guarantee → bounded soft cap; LiteLLM sole authority

**Change.** With the owner's informed approval (given the measured soft-cap finding above), LiteLLM
becomes the **sole active** budget-enforcement + accounting authority. Riverbend's reserve-then-settle
is removed from the active inference path (kept behind `BUDGET_AUTHORITY=legacy` for rollback). I4's
GUARANTEE is redefined from "never exceeds" (hard) to "enforced fail-closed with a bounded
single-in-flight-call overshoot" (soft).

**Bump.** MAJOR (2.0.0): redefining a NON-NEGOTIABLE invariant's guarantee. (1.2.0 had changed only the
mechanism and wrongly kept the guarantee as hard; 2.0.0 corrects the guarantee to the measured reality.)

**Why accepted.** Per-call cost is micros against a $5 cap, so a one-call overshoot is immaterial; teams
are set at/below the chain cap as mitigation. Verified at zero cost via a mock upstream (no paid calls).
D7, Feature 003 FR-007, README and the architecture note are reconciled to match.

## 2026-11-04 — Phase 5 acceptance VERIFIED (Riverbend adapters vs real LiteLLM + Postgres, zero cost)

Ran Riverbend's own `LiteLlmAdmin` + `LiteLlmGateway` against a live LiteLLM 1.106.6 + PostgreSQL with a
mock upstream + configured pricing (no paid OpenAI calls):
1. Successful call → proxy-calculated cost captured (`x-litellm-response-cost` → 155000 micros).
2. Exhausted team budget → calls rejected (HTTP 422 → `BudgetExceededError` → pipeline `held_budget`).
3. **Tenant isolation**: shop B's team budget untouched by shop A's exhaustion (B still succeeded).
4. **Restricted virtual keys** used for inference; the master key is confined to provisioning.
Gateway fix applied: LiteLLM returns **422** for budget rejection (not 400) — mapped to
`BudgetExceededError`. Hermetic tests (92 passing) cover the Riverbend-side logic; this is the live proof.

## 2026-11-04 — Feature 010: Better Auth for human auth; Spec Kit reconciliation

- Adopt **Better Auth 1.7.16 (MIT)** for email/password + sessions (admin()/pg adapter); Riverbend owns
  authorization via `shop_membership` → forced RLS. Shop API keys (009) + LiteLLM virtual keys unchanged.
  Full rationale in ARCHITECTURE_DECISIONS D20; design in specs/010-staff-auth-portal/.
- **Spec Kit reconciliation:** reconstructed the missing `specs/008-eval-deploy/spec.md` from the actual
  implemented eval + Terraform (no invented results). Created specs/010 spec/plan/tasks.

## 2026-11-04 — Feature 006 amendment (D21): Resend is the sole email provider

- **Replace Mailpit/SMTP with Resend** (official `resend` SDK 6.37.0; Svix 2.9.1 for webhook verify).
  Outbound via `ResendTransport` with a stable idempotency key + bounded retry/backoff; inbound via the
  Svix-signed `POST /webhooks/resend` → durable `email_events` (dedup by svix-id) → worker fetches content
  with `emails.receiving.get` → existing signed-token correlation + Message-ID dedup + one-round guard.
  Delivery/bounce events drive a monotonic `delivery_status` (API-200 ≠ delivered). Full rationale in
  ARCHITECTURE_DECISIONS D21 (supersedes D10's provider choice); design in specs/006-email/.
- **Preserved** unchanged: outbox semantics, `tokens.ts` reply correlation, tenant isolation (forced RLS;
  `email_events` is a global no-PII ingestion log), one-question rule, pg-boss/reconciler durability.
- **Removed:** `mailpit` compose service, `nodemailer`, `MailpitTransport`, `src/api/email-webhook.ts`,
  `MAIL_SMTP_*`/`MAIL_FROM`/`MAIL_REPLY_DOMAIN`/`EMAIL_WEBHOOK_SECRET`. Terraform secret `email-webhook-secret`
  → `resend-webhook-secret`; added `resend-api-key`.
- **Tests:** 129/129 (real PostgreSQL); outbound send/idempotency/retry/park + Svix valid/invalid/missing +
  raw-body verify + duplicate-event no-op + inbound fetch+correlate + forged/cross-tenant rejected +
  one-round + monotonic delivery status — all deterministic (fake Resend client + real svix-signed
  fixtures), **no live provider calls**. Real-provider verification (TEST C) BLOCKED without credentials +
  a verified sending domain; manual steps in specs/006-email/quickstart.md.

## 2026-11-04 — Feature 006 (D21.1): inbound by Resend API polling (default local/MVP)

- **Add a polling inbound mode** so local/MVP needs no public URL, webhook, or tunnel. A pg-boss
  self-rescheduling singleton job lists received emails (`emails.receiving.list`, paginated) every
  `RESEND_POLL_INTERVAL_SECONDS` (default 60), discovers ids into `email_events` (dedup), and the existing
  `processPendingEvents` fetches content + correlates. The D21 Svix webhook is **preserved but off unless
  `RESEND_WEBHOOK_SECRET` is set** (production/low-latency); both may run (Message-ID dedup → one effect).
- **Single-flight** via a durable lease (`email_poll_state.claimed_until`) + the pg-boss singleton; provider
  id persisted before the checkpoint advances; order-independent (dedup authoritative); failures release the
  lease and retry next tick. Ordering + retention are **unstated by Resend** — documented assumptions, not
  fabricated. Full rationale in ARCHITECTURE_DECISIONS D21.1; design in specs/006-email/ (D21.1 sections).
- **Env:** +`RESEND_POLLING_ENABLED` (default true), +`RESEND_POLL_INTERVAL_SECONDS` (default 60);
  `RESEND_WEBHOOK_SECRET` now optional. Migration `11100_email_poll.cjs` (`email_poll_state`).
- **Tests:** 138/138 (real PostgreSQL); 9 new polling tests — empty list, one reply e2e, multiple pages,
  duplicate ids, retry-after-failure, worker restart, cursor persistence, single-flight lease, wrong-shop/
  invalid/unrelated token, duplicate Message-ID, one-round. All deterministic (fake lister + fake content);
  **no live provider calls**.
