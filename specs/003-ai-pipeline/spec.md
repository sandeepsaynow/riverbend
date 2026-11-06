# Feature Specification: AI Extraction Pipeline

**Feature Branch**: `003-ai-pipeline`
**Created**: 2026-11-03
**Status**: Draft

> **AMENDMENT 2026-11-06 (D26): production model upgrade.** The backing extraction model behind the LiteLLM
> alias `riverbend-extraction` was upgraded `openai/gpt-4o-mini` → **`openai/gpt-5.4-mini-2026-03-17`**. The
> GPT-5 family requires `max_completion_tokens` (rejects the legacy `max_tokens`), so the gateway was changed
> accordingly (`src/platform/llm/litellm-gateway.ts`; verified by provider smoke test + `tests/unit/gateway-request.test.ts`).
> Prompt, JSON schema, decision, catalog and pricing are **unchanged** — this is a model swap, not a behavior
> change. Rollback is a one-line edit in `litellm/config.yaml`. Measured live run, per-tenant cost accounting and
> quality comparison: `docs/results-live-gpt-5.4-mini.md`, `docs/MODEL_COST_REPORT.md`. See decision **D26**.
**Input**: Slice 003 (D5, D6, D7) — the AI reads a message into a strict, schema-validated form; code
validates, decides, asks at most one follow-up and resumes on reply; every model call is recorded and
its cost reserved then settled against a per-shop monthly cap. The model interprets; **code owns every
decision, price-relevant choice, and side effect**.

## User Scenarios & Testing *(mandatory)*

Picks up a request at `awaiting_pipeline` (from 002) and turns the customer's words into a validated
structure a shop can act on — without ever letting the model decide money, identity, or side effects.

### User Story 1 — Structured extraction, validated before anything is saved (Priority: P1)

The model fills a **strict form** (bikes, reported issues, mapped catalog service codes from the fixed
12, which wheels, urgency, the customer's own date words). Code validates the form against a schema;
**output that fails validation is never persisted as a work order** (I3).

**Independent Test**: Feed messages through a controllable fake model server; valid output yields a
persisted validated extraction; bad JSON or an unknown service code is rejected (one retry with a
stronger model, then `needs_review`), never stored as a usable extraction.

**Acceptance Scenarios**:
1. **Given** a message naming a known repair, **When** the model returns a schema-valid form with
   catalog codes, **Then** the validated extraction is persisted and the request advances.
2. **Given** the model returns invalid JSON or an unknown service code, **When** validation runs,
   **Then** it is rejected, retried once with the escalation model, then parked `needs_review`
   ("invalid output") — never persisted as a work order.
3. **Given** any message, **When** the model is called, **Then** the prompt contains no prices, no
   secrets, no tool access, and no list of shops (prompt-injection containment, D14/m-1024).

### User Story 2 — Code decides; at most one follow-up question (Priority: P1)

From the **validated** form, deterministic code decides the outcome and whether a single clarification
is needed. "Required" = ≥1 catalog service (and which wheels for per-wheel work); bike type and date
never block. At most **one** follow-up question per request (I6), enforced by a database `CHECK`. The
model may only *draft* the question's wording; code gates it (length-capped, no prices/links/PII, same
language, else a fixed template) and decides whether to ask at all.

**Independent Test**: Ambiguous message → exactly one question, request waits `awaiting_customer`; a
second question can never be created (DB CHECK + attempt). After one reply, unresolved-with-symptom →
flagged general inspection (`GENERAL_INSPECT`), else `needs_review`.

**Acceptance Scenarios**:
1. **Given** a message missing a required field, **When** code decides, **Then** exactly one bundled
   question is asked and the request waits in `awaiting_customer`.
2. **Given** a request that already asked its one question, **When** the system tries to ask another,
   **Then** it is refused (DB CHECK keeps follow-up count ≤ 1).
3. **Given** the one reply still leaves it unclear but a symptom exists, **When** code decides, **Then**
   it falls back to a flagged general inspection; with no symptom → `needs_review`.
4. **Given** a message for the wrong shop, **Then** `needs_review` ("wrong shop suspected") — never
   auto-moved. **Given** a price inquiry with no repair, **Then** `answered`, no order. **Given**
   delegation ("whatever it needs"), **Then** a flagged general inspection, no invented repair list,
   no question.

### User Story 3 — Per-shop monthly AI spend cap, reserve-then-settle (Priority: P1)

Each shop has a monthly AI budget. Before a model call, code **atomically reserves** an estimated cost
only if `spent + reserved + estimate ≤ cap`; the call is recorded in a receipt keyed by
`(request, step, attempt)` so a replayed/crashed job reuses the answer and is **never charged twice**;
after the call the real cost is **settled**. At the cap the request parks `held_budget` with an honest
no-AI notice; abandoned reservations are reaped. AI spend is stored in **whole millionths of a dollar**.

**Independent Test**: With a cap that fits K calls, N concurrent reservations succeed exactly K times
(I4); a replayed call reuses its receipt (no second charge); at the cap the request parks `held_budget`.

**Acceptance Scenarios**:
1. **Given** a cap fitting K calls, **When** N>K reservations race, **Then** exactly K succeed and the
   rest park `held_budget`.
2. **Given** a recorded call, **When** its job is redelivered, **Then** the receipt is reused and no
   second charge is made.
3. **Given** a settled call, **When** spend is read, **Then** it equals the recorded real cost in whole
   millionths; totals never exceed the cap.

### Edge Cases
- Invalid model JSON / unknown service code → rejected, retried once, then `needs_review` (never saved).
- Per-wheel service with no wheel named → one follow-up; still unclear → general inspection.
- Model slow/unavailable → handled in slice 007 (timeouts/breaker); here a failed call settles to a
  defined state and is replay-safe.
- Reservation abandoned (crash) → reaper settles it at the estimate; no leak of budget.
- The model never supplies a price or chooses tenant identity; code maps codes to the catalog (pricing
  totals are computed in slice 004).

## Requirements *(mandatory)*

- **FR-001**: Model extraction MUST go through an `LlmGateway` interface; the concrete provider
  (LiteLLM proxy / Vertex AI per D6) is configuration, and a controllable fake gateway MUST exist for
  deterministic tests. The final implementation MUST demonstrate extraction through a **real** provider
  (gated on credentials; see blocker B1).
- **FR-002**: The model MUST only fill a strict, schema-validated form (bikes, issues, catalog service
  codes ∈ the fixed 12, wheels, urgency, date words). It MUST have no tools, memory, secrets, or
  shop-list, and the prompt MUST contain no prices (D14 injection containment).
- **FR-003**: Model output MUST be validated against the schema; output failing validation (bad JSON,
  unknown service code) MUST NOT be persisted as a work order (I3). On validation failure, retry once
  with the escalation model, then park `needs_review` ("invalid output").
- **FR-004**: Deterministic code — never the model — MUST decide the outcome from the validated form.
  "Required" = ≥1 catalog service (+ wheels for per-wheel services); bike type and date never block.
- **FR-005**: At most **one** follow-up question per request, enforced by a database `CHECK`. The model
  MAY draft wording; code MUST gate it (length cap, no prices/links/PII, same language, else a fixed
  template) and decide whether to ask. After one reply, unresolved-with-symptom → flagged general
  inspection; else `needs_review`.
- **FR-006**: Distinct outcomes MUST be handled by code: wrong shop → `needs_review` (never auto-moved);
  price inquiry → `answered` (no order); delegation → flagged general inspection (no invented list).
- **FR-007** (amended 2026-11-04, constitution **2.0.0** — supersedes the 1.2.0 note below): LiteLLM is
  the **sole active** budget authority. One LiteLLM **team per shop** ($5/month default) + restricted
  **virtual keys** the worker selects server-side (never the master key). Admission is **fail-closed**
  and **eventually-consistent** — it rejects over-budget calls (HTTP 422 → `held_budget`) but may exceed
  the cap by **at most one in-flight call** (measured; I4's amended bounded-overshoot guarantee). The
  pipeline does **not** reserve/settle for enforcement in this mode; it records the proxy-calculated cost
  (`x-litellm-response-cost`), model, tokens, and LiteLLM request id per Riverbend request for accounting
  (idempotent; no double-count on replay). `BUDGET_AUTHORITY=legacy` keeps the old reserve-then-settle
  hard-cap path for rollback. See D7 + `docs/decision-log.md`.
- **FR-007 (1.2.0, superseded)**: A per-shop monthly AI budget MUST be enforced by
  **LiteLLM native budgets** — one LiteLLM **team per shop** with a configurable **$5 calendar-month**
  cap, and **restricted virtual keys** the worker uses for inference (never the master key). Admission
  MUST be **reservation-based and fail-closed**: a call over budget is rejected **before reaching the
  provider** → the request parks `held_budget`; if budget state cannot be verified, real inference fails
  closed into a recoverable state. The real cost (`x-litellm-response-cost`), model, tokens, and LiteLLM
  request id MUST be captured **against the Riverbend request** in whole millionths of USD, with a
  **request-scoped usage record** so a redelivered job reuses the recorded result/cost with **no second
  charge** (a usage/correlation record, NOT a competing reservation engine). Riverbend owns the
  calendar-month reset (business policy) and retains tenant identity, `held_budget`, and request-level
  cost references. The legacy reserve-then-settle ledger (below, superseded) is retained behind a flag
  (`BUDGET_AUTHORITY`) for rollback until this passes acceptance (I4). See D7 + `docs/decision-log.md`.
  *Superseded mechanism (kept for history):* an atomic `spent + reserved + estimate ≤ cap` check with a
  receipt keyed `(request, step, attempt)` and post-call settle.
- **FR-008** (amended): Native enforcement holds no Riverbend-side reservations to reap; instead an
  **idempotent reconciliation** against LiteLLM's spend-log API records proxy-calculated cost per request
  and MUST NOT double-count on repeat. (Superseded: reaper settling abandoned reservations at estimate.)
- **FR-009**: Request states extend 002's: `awaiting_pipeline` → `processing` → `extracted` (validated
  form ready; work-order creation is slice 004) | `answered` | `awaiting_customer` | `needs_review` |
  `held_budget`. (`ordered`/`cancelled` arrive in slice 004.)
- **FR-010**: All pipeline state and side effects MUST remain tenant-isolated (RLS) and MUST NOT log
  customer message text or prompts/answers containing PII (Principle VII). The model proposes; code
  performs every side effect.
- **FR-011**: The pipeline MUST NOT compute price totals or create work orders (slice 004); it maps to
  catalog codes only. No emails are sent (slice 006).

## Key Entities
- **Extraction**: the validated strict form for a request — bikes[], issues, service codes (∈ 12),
  wheels, urgency, date words. Persisted only after schema validation (I3). Shop-owned.
- **Follow-up question**: at most one per request (DB CHECK ≤ 1); records the asked question; a reply
  resumes the request.
- **Budget (shop_budgets)**: per-shop monthly cap, `spent_micros`, `reserved_micros` (whole millionths).
- **LLM call receipt (llm_calls)**: keyed `(request, step, attempt)`; estimate + real cost in micros;
  the replay-safety + no-double-charge record.

## Success Criteria
- **SC-001**: Invalid model output is never persisted as a work order (100%); one escalation retry then `needs_review`.
- **SC-002**: At most one follow-up question per request, 100% (DB CHECK proven by a forced second attempt).
- **SC-003**: With a cap fitting K calls, N concurrent reservations succeed exactly K times; totals never exceed the cap.
- **SC-004**: A replayed model call reuses its receipt — zero double charges.
- **SC-005**: Code, not the model, determines every outcome and no price appears in any prompt (injection test m-1024 changes neither price nor urgency).
- **SC-006**: No customer message text, prompt, or answer PII is written to logs.

## Assumptions
- Builds on 001 (RLS, roles, config) + 002 (intake, request, worker). The worker's `awaiting_pipeline`
  step now runs the pipeline.
- Pricing totals and work-order rows are slice 004; this slice persists the validated extraction and
  the decision outcome. New success state `extracted` bridges to 004 (decision logged in AUTONOMOUS_DECISIONS).
- Real provider wiring (LiteLLM/Vertex per D6) is configuration; tests use a fake gateway; the live
  run + the 40-sample eval + cost report are gated on credentials (blocker B1), per the brief's
  free-provider choice and the < USD 20 cap.
- Money/AI-spend representation: whole millionths of a dollar (integers), per D8.

## Amendment (D22, 2026-11-04) — catalog classification taxonomy (general-servicing regression fix)
- **FR-cls1:** clear **routine maintenance** ("service"/"general servicing"/"tune-up"/"routine|regular
  maintenance"/"basic service") → **TUNE_BASIC**; it is NOT ambiguous for lack of a named fault → no
  clarification. **Explicit full/complete overhaul or rebuild** → **TUNE_FULL** (never for the word
  "service" alone). **Diagnostic / unlocalized symptom** → **GENERAL_INSPECT**. **Specific fault** → its
  specific code (never TUNE_BASIC by default). **Price-only** → `price_inquiry`. **Cancellation/change** →
  no new order and no auto-cancel. Else ≤1 clarification (I6).
- **FR-cls2:** this guidance lives in the extraction **system prompt** (generalizable semantics, not
  hardcoded phrase-matching in the production classifier); the offline FakeGateway mirrors it deterministically.
- **FR-cls3:** unknown bike type / date are absent (dateWords null), never fabricated, never a clarification
  trigger. Catalog remains the only price source (I5); schema+catalog validation (I3) and `decide()` unchanged.

## Amendment (D23, 2026-11-04) — cancellation intent → human review
- **FR-cxl1:** a request to **cancel/reschedule/change an existing order** (e.g. "cancel the chain
  appointment … I fixed it myself") → extraction `kind = "cancellation"` → `decide()` returns
  `needs_review` with reason **`cancellation_requires_verification`**. No work order is created, no existing
  order is auto-cancelled, and **no repair clarification email** is sent.
- **FR-cxl2:** `kind` gains `cancellation` in BOTH the Zod schema and the LiteLLM `response_format`
  json_schema enum (unified via `REQUEST_KINDS` — single source of truth). `extractions.kind` is free text →
  no DB migration. Backward compatible.
- **FR-cxl3:** order **ownership is never inferred** from the customer email or message similarity — a human
  verifies. Original message, shop and customer contact are preserved; the reason shows in the staff
  needs-attention view. Idempotency, tenant isolation, catalog pricing (I5) and budgets are unchanged.
