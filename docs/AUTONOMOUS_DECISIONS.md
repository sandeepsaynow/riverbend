# Autonomous Decision Log — Riverbend

Running log of decisions made while completing slices autonomously. Newest first within each feature.
Format: stage · ambiguity · options · decision + rationale · artifacts · tests · risks/deferred.

> Source priority: (1) take-home brief PDF, (2) constitution v1.1.0, (3) REQUIREMENTS.md + ARCHITECTURE_DECISIONS.md, (4) IMPLEMENTATION_SLICES.md + EDGE_CASES.md, (5) existing specs/code. On conflict, brief + tenant-isolation/safety invariants win; conflicts are recorded here.

---

## Global blockers (external inputs required — cannot be fabricated)

- **B1 — Real LLM provider credentials (slice 003+).** The constitution (VIII) requires the final
  AI pipeline to demonstrate extraction through a *real, configured* model provider, and the brief
  requires a 40-sample run with real model spend (< USD 20). A provider key / LiteLLM endpoint /
  Vertex AI service account is a **secret + paid service** → per the mission's blocker policy I build
  the AI pipeline against a **controllable fake model server** (constitution explicitly permits fakes
  for deterministic tests), and leave the real-provider run + live 40-sample eval + cost report as a
  gated step requiring the user's credentials. Nothing is faked or claimed as real.
- **B2 — GCP account (slice 008).** Terraform + live deploy need a cloud account; the brief scores
  IaC + a written plan equally to a live deploy, so IaC/docs are produced, `terraform validate` is
  the only gate attempted, and no live deploy is performed.

These are the brief's own "optional/choose-your-provider" boundaries, not shortcuts.

---

## Feature 002 — intake-queue

- **Convergence (2026-11-03).** Result: **Converged.** All 36 tasks implemented; full suite 40/40
  green (13 intake + 27 from 001) on real PostgreSQL (Testcontainers); live end-to-end through real
  pg-boss verified via `make up` (202 → dedupe → 409 → worker `received → awaiting_pipeline`).
  Documented deviations (accepted, not defects):
  - **Relay latency**: the worker drains the outbox to pg-boss on `RECONCILER_INTERVAL_MS` (10 s), so
    processing begins within that window. FR-003's immediate `202` is satisfied; processing is async.
    Rationale: simplest correct design (no post-commit nudge); no message is ever lost. Tunable.
  - **pg-boss crash recovery** (lease expiration → retry) is verified from pg-boss 12.38.0's own
    maintenance SQL (research R5), not a wall-clock crash test; processor/relay/dead-letter/RLS logic
    is covered by real-PostgreSQL tests with a fake queue, and the real queue by the live `make up`.
- **M1 (analyze)**: pg-boss is the single retry authority; the reconciler never re-enqueues. Applied
  across spec/plan/research/data-model/quickstart/tasks.
- **Idempotency**: keyed only on `(shop, source, submission_id)`; never on content/email/session.
  Content fingerprint used solely for same-id conflict detection (409). Internal UUID PK per message.

---

## Feature 003 — ai-pipeline (checkpoint 1)

- **Spec/plan**: written (lean, grounded in D5/D6/D7 + EDGE_CASES). Routine clarify/analyze/checklist
  folded here per the autonomous mandate; invariant-bearing cores built and tested first.
- **Decision — `extracted` bridge state**: 003 persists the validated extraction and ends a resolvable
  repair at a new `extracted` state; actual work-order creation + price totals are slice 004 (keeps the
  004 boundary clean). Non-order outcomes use D5 states (answered / awaiting_customer / needs_review /
  held_budget). Alternatives: create orders in 003 (rejected — that is 004's scope).
- **Decision — fake gateway default**: tests + local demo use `FakeGateway` (Constitution VIII allows a
  controllable fake AI server); the real `LiteLlmGateway` refuses to run unless `LLM_*` configured, so
  nothing is ever faked as real. Real-provider run is **blocker B1**.
- **Decision — money in micros**: AI spend stored as whole millionths of a dollar (integer `bigint`),
  per D8; cap/spent/reserved all micros.
- **Decision — budget period**: `shop_budgets` keyed by `(shop_id, 'YYYY-MM')`; raising `cap_micros`
  (ensureBudget upsert) is the resume-at-rollover/raised-cap path (D7).
- **I4 atomicity**: one transaction inserts the `(request, step, attempt)` receipt then
  `reserved += est WHERE spent+reserved+est <= cap`; concurrent reserves serialize on the budget row
  (Postgres re-evaluates the WHERE under row lock) → exactly K succeed. Verified by a 20-vs-cap-of-5
  concurrency test. Replay reuses the receipt (UNIQUE key) with no second charge.
- **Tests executed**: `npx vitest run` → **49 passed / 49** (adds 4 extraction + 5 budget to the prior
  40). typecheck clean; dependency-cruiser clean (incl. new llm/budget/pipeline module boundaries).
- **Unresolved/deferred**: 003 decision logic, one-question (I6) + reply resumption, worker wiring, and
  the real-provider run (B1). 004–008 not started.

## Feature 003 — ai-pipeline (checkpoint 2 — functionally complete vs fake gateway)

- **Built + tested:** decision logic (`decide.ts`: wrong-shop→needs_review, price→answered, delegation
  →flagged general inspection, required-field + per-wheel checks); one follow-up question (I6) enforced
  by `UNIQUE(request_id)` on `follow_ups`; reply resumption (`applyReply` + re-run) that resolves to
  `extracted` or falls back to a flagged general inspection; `PipelineService` orchestration
  (reserve→extract→validate+1 escalation retry→settle→decide→persist→state); two-stage worker wiring
  (intake queue → pipeline queue) so 002 behavior is unchanged; held_budget at the cap; gateway
  selection (Fake default, LiteLLM when `LLM_*` set).
- **Decision — two pg-boss queues:** added `ai-pipeline` queue fed after intake reaches
  `awaiting_pipeline`, rather than changing the 002 processor (keeps 002 tests valid; clean layering).
  pg-boss remains the sole retry authority for both queues; both dead-letter → `needs_review`.
- **Decision — reply billed as a new call:** reply extraction uses step `extract-reply` (distinct
  receipt), i.e. a second legitimate model call; initial uses `extract`. Both reserve-then-settle.
- **Verification:** `npx vitest run` → **63 passed / 63** (adds 7 pipeline + 7 decide + 4 extraction +
  5 budget). typecheck + dependency-cruiser clean. **Live:** `make up` → submit → observed
  `received → awaiting_pipeline → extracted` through the real two-stage worker + pg-boss + FakeGateway.
- **Converged* (vs fake):** all planned 003 behavior built + tested. The ONLY outstanding 003 item is
  the real-provider extraction run (blocker **B1**) and the live 40-sample eval/cost (008 + B1) — not
  faked. `extracted` bridges to slice 004 (order creation + pricing).

## Feature 004 — orders-staff

- **Built + tested:** OrdersService.createFromExtraction (one work order per bike, all-or-nothing,
  unique (shop,request,bike)=I2, idempotent); code-computed pricing (unit×qty, whole cents, I5) with
  snapshot of unit price + catalog version + name + inspection flag (later catalog change can't rewrite
  history); per-wheel qty = wheels named; tenant-scoped staff reads GET /v1/orders (+ totals) and
  GET /v1/needs-attention; worker runs orders after pipeline (extracted → ordered).
- **Verification:** `npx vitest run` → **69 passed / 69** (adds 6 orders tests: m-1029=USD150,
  m-1040=two orders USD130, I2 replay, snapshot immutability, requires_inspection=$60, RLS isolation).
  typecheck + dependency-cruiser clean. **Live:** `make up` → submit 'tune' → observed
  received→awaiting_pipeline→**ordered**; GET /v1/orders → 1 order, shop_total 6500, item TUNE_BASIC:6500.
- **Decision — orders as a worker step after pipeline** (not a 3rd queue): the PIPELINE_QUEUE handler
  calls OrdersService after pipeline.run; createFromExtraction no-ops unless state=extracted. Simplest;
  reuses the existing queue. Alternative (separate orders queue) rejected as unnecessary at this scale.
- **Not built this slice (deferred, logged):** verified-channel cancellation + the cancel/processing
  race (D9, needs email/006); server-rendered staff HTML (D17) — staff data exposed as JSON reads.

## 2026-11-04 — LiteLLM-native budget migration (constitution 1.2.0): scoped + timeboxed

- **Approved & applied:** constitution 1.1.0→1.2.0 (I4 enforcement → LiteLLM-native), D7 reversal,
  FR-007/FR-008 rewrite, decision-log entry.
- **Implemented + verified (zero-cost):** real proxy-cost capture (`x-litellm-response-cost` →
  settle at real cost, fixing the prior estimate-only caveat) and **fail-closed `held_budget`** on a
  proxy budget rejection (`BudgetExceededError`), with 2 new tests. Dual-path safe; legacy
  `BudgetService` remains the active, tested I4 authority.
- **Deliberately deferred (timebox + explicit deferral clause):** per-shop LiteLLM **team/virtual-key
  provisioning**, LiteLLM Postgres persistence, and **sole-authority cutover**. Reason: I4's core
  property ("N concurrent → exactly K") cannot be validated against real LiteLLM **without paid
  budget-exhaustion calls** (forbidden) — a zero-cost mock cannot prove the proxy's real admission
  atomicity. Per the mandate ("if native enforcement cannot be validated safely, retain the existing
  tested path, document, and proceed"), legacy enforcement stays authoritative and the mandatory
  Features 005–008 take priority. Native provisioning is specified (FR-007) and the cost/fail-closed
  pieces are in place; cutover is a flag flip once a safe atomicity test exists.
- **Rollback:** no cutover happened; `BUDGET_AUTHORITY` flag reserved for the future flip. Tables
  unchanged (`shop_budgets`, `llm_calls`).

## 2026-11-04 — Feature 006 (D21): Resend replaces Mailpit as the sole email provider

- **Decision:** migrate email to Resend-only (SDK `resend` 6.37.0, `svix` 2.9.1). Chosen because Resend
  offers first-class inbound receiving + a content-retrieval API, an official SDK, Svix-standard signed
  webhooks, idempotency keys, and **domain-free inbound testing** — one provider for both directions.
- **Convention:** amended Feature 006 in place (added research/plan/data-model/contracts/tasks/quickstart/
  checklist to specs/006-email/; preserved the original Mailpit spec text as superseded) rather than
  opening specs/011 — the smallest convention-consistent change, matching the 005–010 branch pattern.
- **Scope held:** no new service/frontend; auth, pricing, LiteLLM, tenant isolation, AI extraction
  untouched. Outbox/correlation/one-round/durability preserved; only the transport + inbound/verify
  mechanism changed.
- **Honesty:** every email test is deterministic (fake Resend client + real svix-signed fixtures); none
  implies real delivery. A full real customer round (TEST C) is **BLOCKED** without credentials + a
  verified sending domain — recorded as BLOCKED with exact manual steps, never fabricated.
- **Door:** two-way — the transport and the webhook verifier are ports; a future provider swap touches
  only the adapters (`ResendTransport`, `SvixVerifier`, `ResendReceiving`).

## 2026-11-04 — Feature 006 (D21.1): Resend API polling for local/MVP inbound

- **Decision:** default local/MVP inbound = **poll the Resend Receiving API** (no webhook/URL/tunnel);
  keep the D21 Svix webhook as an optional production mode (off unless `RESEND_WEBHOOK_SECRET` set).
- **Reuse:** the poller only *discovers* email ids into `email_events`; the existing
  `processPendingEvents` + `handleInbound` do content fetch + correlation + dedup + one-round — unchanged.
  pg-boss drives a self-rescheduling singleton job; a durable DB lease is the single-flight guard.
- **Honesty:** ordering + retention are undocumented by Resend → dedup-by-id is authoritative and the
  retention assumption is documented (webhooks preferred for production). All 9 new tests are deterministic
  (fake lister/content), explicitly provider-API integration — NOT proof of real customer-email delivery.
- **Scope held:** no new service/frontend/Redis/scheduler dep; auth, pricing, LiteLLM, tenant isolation,
  AI extraction untouched. **Door:** two-way — polling + webhook are independent adapters over one pipeline.

## 2026-11-04 — Feature 010 (D20.1): recoverable bootstrap + staff-creation atomicity (P0)

- **Decision:** replace the crash-unsafe bootstrap compensation with a recoverable two-phase marker;
  completion invariant is `admin_user_id IS NOT NULL`. Reconcile-by-email (verifying a credential exists)
  makes retries safe after a crash and convergent under concurrency, with no duplicate admins and no
  lockout. A persistent credential-less orphan is surfaced as `RecoveryRequired` for an explicit operator
  step rather than silently "completed".
- **Grounded, not guessed:** probed real Better Auth — `createUser` is headerless-OK and creates user+
  credential; duplicate → `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`; `setUserPassword`/`removeUser` are
  UNAUTHORIZED headerless; `listUsers` by email unsupported. The fix uses only these verified behaviors +
  migrator-pool identity reads.
- **Scope held:** no new identity service, no custom password hashing, no architectural rewrite. Migration
  appended as `12000` (never precedes an applied migration). 16 new real-PG tests; 154/154 total.

## 2026-11-04 — Feature 010 (D20.2): security re-audit of the bootstrap recovery (P0/P1)

- **Did not trust my own D20.1 tests.** Re-audited and found: reconcile-by-email could adopt a pre-existing
  account as platform-admin; the staff "orphan" heuristic could attach a membership to the platform admin;
  the CSRF guard rejected 127.0.0.1 (host-only, no scheme). All three fixed.
- **Ownership proof:** admin_user_id is only ever an id THIS bootstrap created and recorded; never an
  email lookup. Ambiguity (email exists, not recorded) fails closed to operator recovery — never auto-adopt.
  Staff duplicate fails closed. CSRF uses an exact scheme://host:port allowlist (dev adds the loopback sibling).
- **Grounded:** verified live — 127.0.0.1 now allowed (401 not 403), foreign origin 403, completed-admin 409,
  migrations 12000+12100 (+CHECK) apply. DB-role boundary (Better Auth on migrator role) documented as a prod
  gap rather than shipping an unverified role migration near submission.
