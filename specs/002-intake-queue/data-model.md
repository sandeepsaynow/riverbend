# Phase 1 Data Model: 002-intake-queue

Builds on the 001 model (roles `riverbend_migrator` / `app_user` / `app_admin`, forced RLS, per-tx
`set_config('app.tenant_id', …)`). All new tables are shop-owned (`shop_id`), with RLS **enabled and
forced** and the same tenant/admin policy pattern as 001 (so 001's FR-004 policy build-check covers
them). Exact DDL lives in `src/migrations/3000_intake.cjs`. **Message content is never logged.**

## New runtime behaviour, roles

- The **worker** process accesses `messages`/`requests`/`job_outbox` as `app_user` with a per-job
  tenant binding (`set_config('app.tenant_id', $shop_id, true)`), so RLS holds during processing.
- The **relay** (worker) reads `job_outbox` as `app_user` per-tenant, or batches via `app_admin` for
  cross-shop draining (ids only — documented D2 exception); implementation picks one and tests RLS holds.
- **pg-boss** owns its own `pgboss` schema (queue tables), created/maintained by the migrator/owner
  connection; it stores ids only and is not shop-scoped.

## Entity: Message (`messages`)

The received submission (first slice to store customer text).

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | Internal, Riverbend-assigned (FR-016); distinct from `submission_id`. |
| `shop_id` | UUID | Tenant (FK → `shops(id)`); the RLS scope. |
| `source` | enum(`email`,`web`,`api`) | Channel / integration namespace (R8). |
| `submission_id` | text | The stable source submission identifier (idempotency key). Required (FR-004). |
| `content` | text | Raw customer message body. **Never logged** (Principle VII). |
| `content_fingerprint` | bytea | SHA-256 of the **canonical** content (NFC + whitespace-normalized, R2); used for replay-vs-409. |
| `received_at` | timestamptz | Client-supplied when trustworthy, else server clock (D3). |
| `created_at` | timestamptz | Insert time. |

- **Uniqueness**: `UNIQUE (shop_id, source, submission_id)` — the idempotency key (FR-005). This is the
  concurrency serialization point (R1). Cross-tenant identical `submission_id` → different `shop_id` →
  distinct (no collision).
- **RLS**: `TO app_user USING (shop_id::text = current_setting('app.tenant_id', true))` (+ admin policy).
- **Relationship**: 1:1 with the initiating `requests` row in this slice (replies/threads are slice 006).

## Entity: Request (`requests`)

The unit of work and the **source of truth** for what work exists; its id is the tracking reference.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | The public **tracking reference** returned at intake. |
| `shop_id` | UUID | Tenant (FK → `shops(id)`). |
| `message_id` | UUID | FK → `messages(id)` (composite-key convention: `(message_id, shop_id)`). |
| `state` | enum | `received` → `processing` → `awaiting_pipeline` (terminal-for-002 success); or `needs_review` (parked). |
| `attempts` | integer | **Observability mirror** of pg-boss's own `retry_count` (updated as the processor runs); pg-boss — not this column — enforces the attempt limit (FR-011). |
| `last_error` | text NULL | Short reason when parked (no message content). |
| `processing_started_at` | timestamptz NULL | Set when the processor leases it; informs the chosen pg-boss `expireInSeconds` (not an application re-enqueue clock). |
| `created_at` / `updated_at` | timestamptz | Lifecycle timestamps. |

- **State machine (this slice, no AI) — retries are pg-boss's, not the app's**:
  `received` --processor leases--> `processing` --deterministic step--> `awaiting_pipeline`
  `processing` --worker crash / handler throw, pg-boss retry (attempts remain)--> redelivered → `processing`
  `processing` --pg-boss attempts exhausted (failed/dead-letter)--> `needs_review` (record preserved, visible, never looped)
  Redelivery is driven by pg-boss lease expiration + retry (research R5); the application never re-enqueues
  processing work. `awaiting_pipeline` is terminal for 002; slice 003 replaces the deterministic step with the AI pipeline.
- **RLS**: tenant policy as above. Status reads (`GET /v1/requests/:id`) run as `app_user` bound to the
  caller's shop, so another shop's reference is simply not found.
- **Uniqueness**: one request per message; the idempotency uniqueness lives on `messages`.

## Entity: Job Outbox (`job_outbox`)

The durable job-intent written atomically with message+request (FR-002); drained to pg-boss by the relay.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `shop_id` | UUID | Tenant (FK → `shops(id)`). |
| `request_id` | UUID | FK → `requests(id)` — what to process. |
| `status` | enum(`pending`,`published`) | `pending` until the relay publishes to pg-boss, then `published`. |
| `created_at` / `published_at` | timestamptz | |

- **RLS**: tenant policy as above.
- **Role**: makes enqueue derive from committed state (R3). The relay is idempotent (re-publishing a
  `pending` row is safe because the worker handler is idempotent). The reconciler is the delivery
  backstop: even if the outbox/relay is bypassed, any `requests` row not terminal with an unpublished
  intent is re-delivered (FR-010). Processing retries are pg-boss's, not the reconciler's.

## pg-boss job (not our table)

A dispatch record in pg-boss's own schema. Payload: **ids only** — `{ request_id, shop_id }` (no
content). Carries pg-boss's own lease/retry/attempt bookkeeping; this is the spec's "doorbell."

## Migration grants (3000_intake.cjs)

- `GRANT SELECT, INSERT, UPDATE, DELETE ON messages, requests, job_outbox TO app_user, app_admin`.
- `ENABLE` + `FORCE` RLS on all three; tenant policy for `app_user`, permissive policy for `app_admin`.
- pg-boss schema created by the owner/migrator at worker startup (adapter responsibility), not here.

## Requirement → model mapping (test anchors for /speckit-tasks)

| FR / SC | Enforced by | Proven by |
|---|---|---|
| FR-005 idempotency / SC-002 | `UNIQUE(shop_id, source, submission_id)` + ON CONFLICT | 50 parallel `m-1003` → one request |
| FR-006 conflict / SC-003 | fingerprint compare on same key | same id + different content → 409 |
| FR-015 no content dedup / SC-008 | key excludes content | two different ids, identical content → two requests |
| FR-002 atomic | one tx: messages+requests+job_outbox | partial-failure test → nothing persisted |
| FR-009 idempotent worker / SC-004 | state check in handler | redelivery/replay → no second effect |
| FR-010/FR-011 recovery / SC-005 | pg-boss retries (lease expiration, 3-attempt limit); reconciler re-runs outbox delivery | crash-replay → no loss; poison → needs_review (no app retry loop) |
| FR-014 isolation / SC-006 | forced RLS on new tables | cross-tenant submit/status rejected |
| VII privacy | ids-only logging | emitted logs contain no submitted content |
