# Phase 0 Research: 002-intake-queue

**Method note.** Technology follows the recorded decisions D3 (intake + duplicates) and D4 (job
queue) in `docs/ARCHITECTURE_DECISIONS.md`, not a fresh opinion, and reuses the 001 platform
(config, DB roles + forced RLS, HTTP, logger, migrations, tests). No research subagents were
dispatched: the decisions are settled and the four carried assumptions from the spec review are
resolved here. Each entry: **Decision → Rationale → Alternatives considered.** No NEEDS CLARIFICATION
remain.

## R1. Idempotency key + concurrency (D3, FR-004–FR-007, FR-015)

- **Decision**: Idempotency is keyed only on `(shop_id, source, submission_id)`, enforced by a UNIQUE
  index. Intake does `INSERT INTO messages … ON CONFLICT (shop_id, source, submission_id) DO NOTHING`.
  On a fresh insert it also creates the `requests` row (`state=received`) and a `job_outbox` row in the
  **same transaction**. On conflict it loads the existing message + request and compares the stored
  canonical content fingerprint: equal → return the existing request's reference (replay); different →
  `409`. A submission with no `submission_id` is rejected (never content-hashed, FR-015).
- **Rationale**: The UNIQUE index makes concurrency safe without application locking — two concurrent
  identical submissions serialize on the index: the first to insert wins; the second's `INSERT … ON
  CONFLICT DO NOTHING` **blocks on the index until the first transaction commits**, then sees the
  conflict and resolves to the committed request. Exactly one request results (SC-002). Keying on the
  identifier (not content) means two customers with identical text, or the same customer re-booking,
  get distinct requests (FR-015, SC-008).
- **Alternatives considered**: content-hash idempotency (rejected in the spec revision — equal content
  ≠ equal logical submission); advisory locks or SELECT-then-INSERT (rejected — racy; the unique index
  is the correct serialization point).

## R2. Canonical payload comparison (carried assumption #1)

- **Decision**: "Same vs different content" is decided over a **canonical form** of the payload:
  Unicode-normalize (NFC), trim leading/trailing whitespace, and collapse internal runs of whitespace
  to a single space — applied to the message body only. The `content_fingerprint` is `SHA-256` of that
  canonical form, stored on the message. Replay/`409` compares fingerprints, so trivial whitespace or
  encoding differences do **not** produce a false `409`; a genuine wording change does.
- **Rationale**: Prevents brittle conflicts on insignificant formatting while still catching real
  content changes under a reused identifier (FR-006). Canonicalization is deterministic and testable.
- **Alternatives considered**: raw-byte comparison (rejected — whitespace/encoding noise false-409s);
  semantic/similarity comparison (explicitly out of scope — FR-015, not permitted).

## R3. Atomic intake + durable queue: transactional outbox (D3, D4, FR-002/FR-010)

- **Decision**: One transaction writes `messages` + `requests(received)` + `job_outbox(pending)` — the
  atomic "message + request + job" unit (FR-002). A **relay** (in the worker process) claims pending
  `job_outbox` rows and publishes them to **pg-boss**, marking them `published` (at-least-once
  doorbell). The durable truth is the `requests` row; pg-boss is the dispatcher. If a publish is lost,
  the **reconciler** re-derives *delivery* from request state (re-runs outbox publish, FR-010) — it does
  **not** retry processing (pg-boss owns that, R4/R5).
- **Rationale**: pg-boss cannot enlist in our application transaction, so enqueuing inside the same
  transaction is not possible; the outbox makes the enqueue **derived from committed state** rather
  than racing the commit. This is exactly D4's "the queue is a doorbell, not the memory; the DB holds
  truth; and recovery is reconciled from request state — with pg-boss owning processing-job retries."
- **Alternatives considered**: enqueue to pg-boss after commit with no outbox (rejected — a crash
  between commit and enqueue would strand the request until the reconciler; the outbox makes delivery
  first-class and the relay idempotent); enqueue inside the tx via pg-boss internal APIs (rejected —
  not supported transactionally with our pool; couples us to pg-boss internals).

## R4. Worker processing + recovery (D4, D16, FR-009/FR-011)

- **Decision**: The worker consumes a pg-boss job carrying **ids only** `(request_id, shop_id)`, opens
  a tenant-bound transaction (`set_config('app.tenant_id', shop_id, true)` as `app_user`), and advances
  the request `received → processing → awaiting_pipeline`. Handlers are **idempotent**: if the request
  is already `awaiting_pipeline`, the job acks with no change (redelivery/replay is a no-op). On
  failure the handler **throws** and **pg-boss** schedules the retry; a crashed worker's job is
  recovered by pg-boss **lease expiration** (verified, R5). **pg-boss is the sole retry authority** —
  retries, backoff, and the attempt limit (default 3 total) all live there. The application
  **reconciler** does **not** re-enqueue processing work; it re-runs outbox *delivery* and, on pg-boss
  retry exhaustion (its failed/dead-letter state), preserves the intake record and transitions the
  request to `needs_review` (poison work, visible, never looped).
- **Rationale**: at-least-once delivery + crashes are normal (Principle VI); a single retry authority
  (pg-boss) + idempotent handlers guarantee no loss, no double-count, and no infinite loop (FR-011,
  SC-004/SC-005). Never hold a DB transaction open across slow work (none here; matters in 003).
- **Alternatives considered**: a separate application sweeper that independently re-enqueues stuck work
  (rejected per analyze M1 — a second competing retry mechanism); carrying the message payload in the
  job (rejected — duplicates truth, risks logging content; ids-only is the D2 exception); unbounded
  retry (rejected — poison jobs loop forever).

## R5. Tenant-binding + pg-boss privileges (carried assumption #3, D2/D4)

- **Decision**: The queue adapter runs pg-boss against the **migrator/owner** connection for its own
  schema creation/maintenance, and the **worker** does all request/message access as `app_user` with
  per-job `set_config` tenant binding — so RLS holds during processing. Job payloads carry ids only (no
  shop data), the documented D2 cross-shop exception. pg-boss's `pgboss` schema is not shop-scoped
  (it holds queue ids only).
- **Rationale**: keeps the forced-RLS guarantee intact during background processing; confines pg-boss's
  elevated schema privileges to the owner role, not the runtime `app_user`.
- **Verification required (guide Appendix E)**: pg-boss install/schema privileges under the 001 role
  split — the implementation MUST confirm pg-boss can create/own its schema as the migrator and that
  `app_user` needs no pg-boss-table privileges (the adapter owns that connection). A test asserts the
  worker still processes under RLS as `app_user`.
- **Crash-recovery behaviour — VERIFIED against the installed version (pg-boss 12.38.0, pin major `12`)**:
  inspected the package's compiled maintenance SQL. `expireJobs` routes an expired `active` job through
  `failJobsBody`, whose state is `CASE WHEN retry_count < retry_limit THEN 'retry' ELSE 'failed'`. So a
  crashed worker's job **is** automatically re-queued by **lease expiration** while attempts remain, and
  moves to `failed` (→ `deadLetter` queue if configured) when exhausted. This confirms lease-expiration
  redelivery is real and is pg-boss's job, not the app's. **Required configuration (not automatic by
  default)** — the implementation MUST: set `retryLimit = 2` (⇒ 3 total), set an explicit
  `expireInSeconds` **well below** the 15-minute default (e.g. 60–120 s, above worst-case run) so
  recovery is timely, keep pg-boss maintenance/`supervise` running (it performs `expireJobs`), and
  configure a `deadLetter` queue (or watch the `failed` state) so exhaustion → `needs_review`.
  **Gap/caveat to honour**: with `retryLimit = 0` an expired job goes straight to `failed` with **no**
  redelivery; redelivery is guaranteed only with `retryLimit > 0` + maintenance enabled. Behaviour and
  option names differ across pg-boss majors — pin `12.x` and re-verify on any major bump.
- **Alternatives considered**: running pg-boss as `app_user` (rejected — it needs schema DDL; violates
  least privilege); a separate queue datastore (rejected — D4 keeps one Postgres; no new infra); an
  application sweeper re-enqueuing stuck work (rejected — M1; pg-boss's lease expiration already covers
  crash recovery, so a second mechanism would double-count).

## R6. HTTP contract (carried assumption #2, D3)

- **Decision**: `POST /v1/messages` (shop credential) → **`202 Accepted`** with `{ request_id,
  status_url }`; duplicate-with-different-content → **`409`**; malformed/missing fields (incl. missing
  `submission_id`) → **`422`**. `GET /v1/requests/:id` (shop credential) → `200` with the request's
  state, or `404` (incl. cross-tenant, which is indistinguishable from not-found under RLS). `202
  Accepted` is the HTTP status; the internal success state is `awaiting_pipeline` (distinct concepts).
- **Rationale**: D3's public, one-way contract (202 + status + conflict). Reuses 001's `shopAuth`,
  typed-route helper, and error handler.
- **Alternatives considered**: `200` on accept (rejected — `202` signals async per D3); returning the
  internal state name as the HTTP status (rejected — conflates HTTP with domain state).

## R7. Privacy — message content never logged (Principle VII, newly active)

- **Decision**: This is the first slice storing customer text. Structured logs/traces carry only ids
  (request/shop/submission id, source, state) — **never** message content or the content fingerprint's
  source text. The 001 pino logger already omits message text; intake/worker log lines are id-only, and
  a test asserts emitted logs contain no submitted content.
- **Rationale**: Principle VII / D15 — logged data cannot be un-logged; customers put real PII in text.
- **Alternatives considered**: debug-logging raw payloads (rejected — violates VII).

## R8. Terminology — source / integration namespace (carried assumption #4)

- **Decision**: One field named **`source`** throughout (schema column, API field, tests), taking an
  enum-like value identifying the channel/integration namespace: `email` | `web` | `api`. The
  idempotency key is `(shop_id, source, submission_id)`. "channel" (brief) and "integration namespace"
  (review) are the same concept; the code uses `source`.
- **Rationale**: avoids drift between the brief's "channel", D3's "source", and the review's "namespace".
- **Alternatives considered**: free-text source (rejected — a closed set keeps the key stable and the
  namespace meaningful).

## Resolved unknowns summary

| Field | Resolution | Source |
|---|---|---|
| Queue | pg-boss behind `JobQueue` interface, own schema | D4 (R1,R3,R5) |
| Idempotency key | `(shop_id, source, submission_id)` UNIQUE + ON CONFLICT | D3 (R1) |
| Canonical content | NFC + whitespace-normalized, SHA-256 fingerprint | assumption #1 (R2) |
| Atomic intake | transactional outbox + relay; pg-boss owns retries, reconciler owns delivery | D3/D4 (R3,R4,R5) |
| Tenant binding | worker = `app_user` + per-job `set_config`; pg-boss schema owned by migrator | D2 (R5) |
| HTTP | 202 + status endpoint, 409 conflict, 422 validation | D3 (R6) |
| Privacy | ids-only logging, no message content | Principle VII (R7) |
| Terminology | one field `source` ∈ {email, web, api} | assumption #4 (R8) |

No NEEDS CLARIFICATION remain. Proceed to Phase 1.
