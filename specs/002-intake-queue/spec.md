# Feature Specification: Intake & Durable Queue

**Feature Branch**: `002-intake-queue`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "Slice 002-intake-queue — a message sent to the service is saved exactly
once together with its request and a processing job, and acknowledged immediately with a tracking
reference. The same message arriving twice yields the same request (a conflicting duplicate is
rejected). A worker picks up queued work and completes it; work stuck mid-processing is automatically
recovered so nothing accepted is ever lost; redelivered work is never processed twice. Still calls no
AI — interpreting the message is slice 003."

## User Scenarios & Testing *(mandatory)*

This slice makes the service **accept work reliably and never lose it**, without yet interpreting any
message (no AI). It builds directly on the foundation (001): every message belongs to exactly one
shop, and shop identity comes from the authenticated credential. A shop owner should be able to agree
that "if the service said it got my customer's message, that message will be worked — once — and will
never silently vanish."

### User Story 1 - An accepted message is recorded once and acknowledged immediately (Priority: P1)

A sender submits a message for a shop. The service records the message, the work request derived from
it, and a job to process it **as one all-or-nothing unit**, then immediately returns an acknowledgement
containing a tracking reference and where to check status — before any slow background work begins.

**Why this priority**: This is the backbone the whole pipeline hangs from and a core "hard part" of the
brief (asynchronous processing). Half the evaluation weight sits on structure and failure handling. If
only this shipped, the service would reliably accept and track work.

**Independent Test**: Submit a well-formed message; confirm a single message + request + job are
persisted together, an immediate acknowledgement with a tracking reference is returned, and if the
atomic write cannot complete, nothing at all is persisted.

**Acceptance Scenarios**:

1. **Given** an authenticated shop, **When** it submits a valid message, **Then** the service persists
   the message, its request, and a processing job atomically and returns an immediate acknowledgement
   with a tracking reference and a status location.
2. **Given** a submission, **When** it is accepted, **Then** the acknowledgement is returned before any
   background processing starts.
3. **Given** a failure partway through persisting, **When** the write cannot complete, **Then** nothing
   is persisted and the sender may safely retry the same submission.
4. **Given** a submission, **When** it is recorded, **Then** its request begins in a defined "received"
   state that is retrievable by the tracking reference.

---

### User Story 2 - Duplicates never create duplicate work (Priority: P1)

The same message can arrive more than once (retries, at-least-once delivery). A repeat that is truly the
same produces the **same** request and reference, not a new one. A repeat that reuses an identifier but
carries different content is refused as a conflict rather than silently overwriting or duplicating.

**Why this priority**: Idempotency is an explicit hard part of the brief; duplicate work orders are
exactly what the system must prevent. It is inseparable from US1 and shares top priority.

**Independent Test**: Submit the same message twice (and many times concurrently) and confirm exactly
one request exists and the same reference is returned each time; submit the same identifier with
different content and confirm it is rejected as a conflict.

**Acceptance Scenarios**:

1. **Given** a message already accepted, **When** an identical message (same shop, source, and external
   message id, same content) arrives again, **Then** the same tracking reference is returned and no new
   request or job is created.
2. **Given** many identical submissions sent at the same instant, **When** they are processed, **Then**
   exactly one request is created.
3. **Given** a message already accepted, **When** a submission reuses the same shop, source, and external
   message id but carries different content, **Then** it is rejected as a conflict and the original is
   left unchanged.
4. **Given** a source that does not supply an external message id, **When** a message is submitted,
   **Then** the service assigns a stable id so idempotency is still well-defined.

---

### User Story 3 - Background processing with automatic recovery (Priority: P2)

A worker takes queued jobs, processes each, and marks it done. Because delivery is at-least-once and
processes can crash, processing is **safe to run more than once** (no duplicate effect), and any work
left stuck part-way is **automatically returned to the queue** after a bounded time so it is never lost.
The durable store — not the queue — is the source of truth, so pending work can be rebuilt from request
state.

**Why this priority**: "No accepted message is ever lost" and honest behavior under crashes/redelivery
is a graded failure-handling concern. It depends on US1/US2 existing first.

**Independent Test**: Enqueue work and confirm a worker completes it and the request reaches
`awaiting_pipeline`; redeliver the same job and confirm no second effect; crash a worker mid-processing
and confirm the queue (pg-boss lease expiration) redelivers it within the bounded time and it then completes.

**Acceptance Scenarios**:

1. **Given** a queued job, **When** a worker leases and processes it, **Then** the request advances to
   `awaiting_pipeline` and the job is marked complete.
2. **Given** a job that is redelivered (or the same message replayed), **When** it is processed again,
   **Then** no duplicate request, job effect, or state change is produced.
3. **Given** a job whose worker crashed mid-processing, **When** the job's lease expires, **Then** the
   queue (pg-boss) redelivers it within the attempt limit and it is eventually completed — the accepted
   message is never lost; the application schedules no retry of its own.
4. **Given** the queue's dispatch records are emptied or lost, **When** the reconciler rebuilds from
   request state, **Then** every request whose durable outbox intent is unpublished is re-delivered to
   the queue (delivery, not a processing retry).

---

### User Story 4 - Look up a request's status (Priority: P2)

Anyone holding a request's tracking reference (the sender, or a shop system) can look up that request's
current state for that shop.

**Why this priority**: The acknowledgement in US1 promises a place to check status; this makes that
promise real. It is small and depends on US1.

**Independent Test**: Accept a message, then fetch its status by reference and confirm the state is
reported and scoped to the owning shop.

**Acceptance Scenarios**:

1. **Given** an accepted request, **When** its status is requested by reference by the owning shop,
   **Then** its current state is returned.
2. **Given** a reference, **When** a different shop requests it, **Then** it is not found for that shop
   (isolation holds).

---

### Edge Cases

- The same message (same shop, source, source submission identifier, content) is submitted many times,
  including concurrently → exactly one request; the same reference every time.
- The same shop/source/identifier is reused with different content → rejected as an idempotency conflict
  (HTTP 409); the original request is unchanged.
- Two submissions carry **different** source submission identifiers but identical (or similar) content —
  e.g. two different customers, or the same customer booking the same repair again → **two distinct
  requests**; they are never merged by content (FR-015).
- A submission supplies no source submission identifier → rejected (never content-hashed).
- A submission omits other required fields, or its content exceeds **20,000 characters** → deterministically
  rejected before anything is persisted.
- A submission tries to set a shop other than the authenticated one (in the body/path) → ignored; the
  shop comes from the credential.
- The atomic write fails partway (store error) → nothing persisted; a retry with the same identifier is safe.
- A customer reply (handled in a later slice) arrives with its own identifier → correlated to its existing
  conversation/request, never treated as a duplicate initial submission (FR-017).
- A worker crashes after leasing a job but before completing it → the job is redelivered and the
  idempotent handler produces no duplicate.
- A job is still legitimately processing (within its lease/deadline) → it is not redelivered prematurely.
- The queue contents are lost → pending work is rebuilt from request state; nothing accepted is lost.
- This slice performs no interpretation of the message content (no AI); "processing" only advances the
  request through defined states.

## Clarifications

### Session 2026-11-03

- Q: How is idempotency keyed for inbound messages? → A: By a **required stable source submission
  identifier** (idempotency key) per source — **never** by message content. Email ingestion uses the
  trusted provider message identifier (e.g. `Message-ID`); the web form generates a UUID per logical
  submission and reuses it on retries; the normalized API requires an explicit key. Riverbend also
  assigns its own internal UUID primary key to every accepted message. Uniqueness is enforced on
  (tenant, source/integration namespace, source submission identifier).
- Q: With no AI yet, what state does the worker move a request to after its deterministic processing
  step? → A: A neutral terminal-for-002 state **`awaiting_pipeline`** ("intake complete, awaiting the AI
  pipeline added in slice 003") — reached as received → processing → awaiting_pipeline.
- Q: What is the recovery policy for work stuck mid-processing? → A: The durable queue (pg-boss) is the
  single retry authority: a crashed worker's job is recovered by lease expiration and retried within a
  configurable limit (default 3 total attempts, including the first); after exhaustion the request parks
  in a visible needs-attention state. The application runs no competing retry loop. (Refined by the M1
  resolution — see FR-011.) Nothing is lost and a poison job cannot loop forever.

### Session 2026-11-03 (revision — idempotency strategy)

- Q: Should identical message content be treated as a duplicate submission? → A: **No.** Content-based
  deduplication (the earlier content-fingerprint default) is **rejected**: two different customers may
  submit identical repair descriptions, and the same customer may legitimately request the same repair
  again later — equal content is not an equal logical submission. Idempotency is keyed **only** on the
  source submission identifier (above). Submissions with different identifiers are never merged merely
  because their content matches; a submission with no identifier is rejected rather than content-hashed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST accept inbound messages only through an authenticated, shop-scoped intake
  that derives the shop from the credential, never from the request body or path (reuses 001).
- **FR-002**: On accepting a valid message, the service MUST persist the message, its derived request,
  and a processing job as a single all-or-nothing unit; if any part cannot be persisted, none is.
- **FR-003**: The service MUST return an immediate acknowledgement — containing a tracking reference and
  a status location — before any background processing begins.
- **FR-004**: Each inbound message MUST carry a source (e.g. email / web / api) and a **stable source
  submission identifier** (idempotency key). The identifier's provenance is per source: email ingestion
  uses the trusted provider message identifier (e.g. `Message-ID`); the web form generates a UUID per
  logical submission and reuses it on retries; the normalized API requires an explicit key. A submission
  that supplies no source submission identifier MUST be rejected (not content-hashed).
- **FR-005**: The service MUST enforce uniqueness on (shop/tenant, source/integration namespace, source
  submission identifier) and treat that tuple as the idempotency key: a repeat with the same key and the
  same content MUST return the existing request's tracking reference and create no new request or job.
- **FR-006**: A repeat with the same idempotency key but different content MUST be rejected as an explicit
  idempotency conflict (HTTP 409), leaving the original request unchanged.
- **FR-007**: Concurrent identical submissions of the same idempotency key MUST result in exactly one
  request (no race may create duplicates).
- **FR-008**: Every accepted request MUST have a defined lifecycle state beginning at `received`, and the
  state MUST be retrievable by the tracking reference, scoped to the owning shop. In this slice the
  worker advances a request `received` → `processing` → `awaiting_pipeline` ("intake complete, awaiting
  the AI pipeline added in slice 003"); `awaiting_pipeline` is the terminal-for-002 success state.
- **FR-009**: A worker MUST lease queued jobs, process each (advancing it to `awaiting_pipeline`), and mark it
  complete; job processing MUST be idempotent so that redelivery or replay produces no duplicate
  request, effect, or state change.
- **FR-010**: The durable store (not the queue) MUST be the source of truth; the service MUST be able to
  rebuild pending work by re-enqueuing every request not yet in a terminal state.
- **FR-011**: The **durable job queue (pg-boss) is the single authority** for processing-job retries,
  backoff, lease-based crash recovery, and the attempt limit, which MUST default to **3 total processing
  attempts (including the first)** and be configurable. A worker that crashes mid-processing MUST have
  its job recovered and retried by the queue's lease-expiration mechanism (within the attempt limit) —
  the application MUST NOT run a second, independent retry loop that re-enqueues processing work. The
  application reconciler MAY re-run durable **outbox delivery** and reconcile request status, but MUST
  NOT schedule processing retries. When the attempt limit is exhausted the intake record MUST be
  preserved and the request transitioned to a visible `needs_review` state. No accepted message is ever
  lost, and a persistently failing (poison) job MUST NOT loop forever.
- **FR-012**: The service MUST reject a malformed submission before persisting anything, with a clear
  reason. Message content MUST be at most **20,000 characters** (consistent with the API contract); a
  submission exceeding that limit MUST be rejected **deterministically** (same input → same rejection),
  before anything is persisted.
- **FR-013**: This feature MUST NOT interpret message content or perform any AI/model processing; worker
  "processing" in this slice only advances a request through defined, deterministic states.
- **FR-014**: All intake and status operations MUST remain subject to the database-enforced shop isolation
  established in 001 (a shop can only submit for, and see, its own requests).
- **FR-015**: Only submissions sharing the **same source submission identifier within the same tenant
  and source namespace** are eligible for transport-level deduplication. The service MUST NOT
  deduplicate or semantically merge submissions with different identifiers, even when their content is
  identical or similar — equal content is not an equal logical submission (different customers, or the
  same customer requesting the same repair again later). A content fingerprint is permitted **solely**
  to detect conflicting reuse of one identifier (FR-006), never to key or merge deduplication.
- **FR-016**: The service MUST assign its own internal UUID primary key to every newly accepted message,
  distinct from the source submission identifier; the external identifier is used only for idempotency,
  never as the internal primary key.
- **FR-017**: Customer replies (handled in a later slice) carry their own message identifiers and MUST be
  correlated to the existing conversation/request, never treated as a duplicate initial submission; this
  slice's idempotency keying MUST NOT preclude that correlation.
- **FR-018**: Logs and traces MUST NOT contain raw customer message content, customer email addresses,
  authentication credentials, or any other sensitive intake payload field. Only safe operational
  metadata MAY be logged — request id, shop id, source, submission id, request state, timestamps, and
  counts (Principle VII).

### Key Entities *(include if feature involves data)*

- **Inbound Message**: A received submission. Attributes: an internal UUID primary key (Riverbend-
  assigned, distinct from the external identifier); owning shop; source (email / web / api); the
  **source submission identifier** (required idempotency key, e.g. a provider `Message-ID` or a web
  UUID); received timestamp; content; and a content fingerprint used **only** to detect
  same-identifier/different-content conflicts (never to key idempotency across identifiers). Shop-owned
  (tenant-scoped).
- **Request**: The unit of work derived from a message. Has a stable tracking reference, a lifecycle
  state, and belongs to one shop. Unique per (shop/tenant, source/integration namespace, source
  submission identifier). The source of truth for what work exists. States in this slice: `received`
  (initial) → `processing` → `awaiting_pipeline` (terminal-for-002 success), or parked in a needs-attention
  state after exhausting recovery attempts.
- **Job**: A queued instruction to process a request. Carries lease/attempt information and a stuck-work
  deadline; is safe to deliver more than once; is a "doorbell," not the system of record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of accepted submissions receive an immediate acknowledgement with a usable tracking
  reference before any background processing begins.
- **SC-002**: Given N identical concurrent submissions of one source submission identifier (e.g. 50),
  exactly **one** request and one job are created — 100% of the time, with zero duplicates. (A message
  delivered twice under the same identifier — as sample `m-1003` is in the brief's dataset — yields one
  request.)
- **SC-003**: A repeat with the same source submission identifier and different content is rejected as an
  idempotency conflict (HTTP 409) in 100% of cases, and the original request is unchanged.
- **SC-008**: Two submissions with **different** source submission identifiers but identical content
  produce **two** distinct requests — content-based merging never occurs — 100% of the time.
- **SC-004**: A redelivered or replayed job produces no second effect (no duplicate request or repeated
  state change) in 100% of cases.
- **SC-005**: Work left stuck in processing is returned to the queue within the bounded deadline and
  reaches `awaiting_pipeline`, or parks in `needs_review` once the attempt budget (default **3 total
  attempts, including the first**) is exhausted; across crash-and-replay tests, **zero** accepted
  messages are lost, retries never exceed the budget, and no second retry mechanism double-counts.
- **SC-006**: A request's status is retrievable by its reference and correctly reflects its current state,
  and is never returned to a shop other than its owner.
- **SC-007**: No message content is interpreted and no AI call is made in this slice (verifiable by the
  absence of any model interaction in intake and processing).
- **SC-009**: Across intake and processing, emitted logs and traces contain **no** raw message content,
  customer email address, or credential — only safe operational metadata (ids, source, state,
  timestamps, counts) — verifiable by scanning logs for submitted content.

## Assumptions

- This slice builds on 001 and reuses its authenticated, shop-scoped access and database-enforced
  isolation; the intake credential is a shop credential.
- Message interpretation, the one follow-up question, pricing, work-order creation, email, and the web
  form are out of scope here (slices 003–006).

### Technical assumptions carried into `/speckit-plan`

These are plan-level decisions deliberately left to `/speckit-plan` (per D3/D4); they do not change the
requirements above:

- **Canonical payload comparison.** "Same content" vs "different content" (FR-005 replay vs FR-006
  conflict) MUST be decided against a defined **canonicalization** of the payload (e.g. trimmed /
  whitespace- and encoding-normalized) so a trivial formatting difference does not produce a false
  `409`. The content fingerprint is computed over that canonical form.
- **HTTP 202 response + status endpoint.** The immediate acknowledgement is returned as **`202 Accepted`**
  (an HTTP status code — distinct from the internal `awaiting_pipeline` state) carrying the **request id**
  and a **status endpoint** for polling; the idempotency conflict is **`409`** (FR-006). This is
  public-API and one-way per D3.
- **pg-boss worker tenant-binding + privilege verification.** The job queue is **pg-boss** behind a
  `JobQueue` interface (D4). Job payloads carry **ids only** (request id + shop id — the documented D2
  cross-shop exception); the worker sets `app.tenant_id` per job and processes as the tenant-scoped
  `app_user`, so RLS holds during processing. Planning MUST verify pg-boss's install/schema privileges
  against 001's role model (`app_user`/`app_admin`/migrator) — flagged unverified in the guide (Appendix E).
- **Consistent source/integration namespace terminology.** "source" = channel (`email` / `web` / `api`)
  = the "source/integration namespace" in the idempotency key; the plan MUST use one consistent name for
  this field across schema, API, and tests.
- The specific queue technology, database, and language are inherited from 001's decisions
  (`docs/ARCHITECTURE_DECISIONS.md` D3, D4) and are chosen in `/speckit-plan`, not here.
- The source submission identifier is sourced per channel: email uses the trusted provider message
  identifier (e.g. `Message-ID`); the web form generates a per-logical-submission UUID reused on retries;
  the normalized API requires an explicit key. There is no content-hash fallback — a submission without
  an identifier is rejected (FR-004/FR-015). The evaluation runner (later slice) replays the brief's
  supplied sample `message_id` values, including the duplicated `m-1003`, exercising same-identifier
  dedup. Riverbend assigns its own internal UUID primary key to every accepted message (FR-016).
- The terminal-for-002 success state is `awaiting_pipeline` (intake complete, awaiting the AI pipeline); a
  request may instead park in a needs-attention state after exhausting recovery attempts. The full
  request state machine with AI outcomes arrives in slice 003.
