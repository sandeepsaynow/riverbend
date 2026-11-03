---
description: "Task list for 002-intake-queue implementation"
---

# Tasks: Intake & Durable Queue

**Input**: Design documents from `specs/002-intake-queue/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml),
[quickstart.md](./quickstart.md)

**Tests**: REQUIRED (Constitution VIII + the slice loop: every invariant/guarantee gets a test).
Idempotency, concurrency, crash-replay, isolation, and privacy tests run against **real PostgreSQL**
(Testcontainers, from 001). No AI ⇒ no fake-model server.

**Builds on 001**: reuses `shopAuth`, `Db.withTenant`/roles + forced RLS, typed config, pino logger,
`node-pg-migrate`, the typed-route helper, and the test harness. Paths follow [plan.md](./plan.md).

## Scope guard (do not build ahead)

- FR-013: **no AI/model processing**; FR-015: **no semantic/content dedup**. No work orders, pricing,
  email, or web-form UI (slices 003–006). The worker performs only the deterministic
  `received → processing → awaiting_pipeline` step. `202 Accepted` is an HTTP status, not the state.

---

## Phase 1: Setup

- [x] T001 Add `pg-boss` (exact pinned version) to `package.json` dependencies
- [x] T002 [P] Add worker/queue settings to `.env.example`: `MAX_PROCESSING_ATTEMPTS` (default **3** — total attempts including the first; maps to pg-boss `retryLimit = MAX_PROCESSING_ATTEMPTS − 1`) and `STUCK_DEADLINE_MS` (the job `expiration`/lease pg-boss uses to redeliver a crashed worker's job — set above worst-case run time)
- [x] T003 [P] Extend `docker-compose.yml` with a `worker` service (same image, `command: npm run start:worker`, same env as api) so `make up` runs api + worker
- [x] T004 [P] Extend `.dependency-cruiser.cjs` boundary rules to the new modules (`src/modules/intake`, `src/platform/queue`, `src/worker/*`): api must not import worker processing code; business modules talk only via `index.ts`; modules import the queue only via the `JobQueue` port

---

## Phase 2: Foundational (blocking prerequisites)

- [x] T005 Migration `src/migrations/3000_intake.cjs` — three shop-owned tables with forced RLS + tenant/admin policies (mirrors 001), per [data-model.md](./data-model.md):
  - `messages` (`id` uuid PK; `shop_id` uuid FK→shops; `source` enum **`email|web|api`**; `submission_id` text **NOT NULL**; `content` text; `content_fingerprint` bytea; `received_at` timestamptz; `created_at`) with **`UNIQUE (shop_id, source, submission_id)`** (the idempotency key)
  - `requests` (`id` uuid PK = tracking reference; `shop_id`; `message_id` uuid FK; `state` enum **`received|processing|awaiting_pipeline|needs_review`** default `received`; `attempts` int default 0; `last_error` text null; `processing_started_at` timestamptz null; `created_at`/`updated_at`)
  - `job_outbox` (`id` uuid PK; `shop_id`; `request_id` uuid FK; `status` enum **`pending|published`** default `pending`; `created_at`; `published_at` null)
  - `GRANT … TO app_user, app_admin`; `ENABLE`+`FORCE` RLS on all three; `app_user` tenant policy (`shop_id::text = current_setting('app.tenant_id', true)`), `app_admin` permissive policy
- [x] T006 Extend typed config in `src/platform/config/index.ts` with `STUCK_DEADLINE_MS` and `MAX_PROCESSING_ATTEMPTS` (default 3), validated; refuse-to-start if present-but-invalid
- [x] T007 Define the `JobQueue` port in `src/platform/queue/index.ts`: `publish(name, {request_id, shop_id})`, `work(name, handler)`, `start()/stop()` — payloads carry **ids only** (D2 exception)
- [x] T008 pg-boss adapter in `src/platform/queue/pgboss-adapter.ts` implementing `JobQueue`; pg-boss owns its `pgboss` schema via the **migrator/owner** connection. **pg-boss is the SINGLE authority for retries, retry scheduling, attempt limits, and backoff** (FR-011): configure `retryLimit` so total attempts = `MAX_PROCESSING_ATTEMPTS` (default **3**, including the first), plus `retryBackoff` and a job `expiration`/lease so a crashed worker's job is redelivered by pg-boss. Use pg-boss's **supported** leasing / failure / expiration / recovery behaviour, **verified against the installed pg-boss version** (research R5). The application MUST NOT add a second, independent re-enqueue/retry loop.
- [x] T009 [P] Canonicalization + fingerprint helper in `src/modules/intake/canonical.ts`: NFC-normalize, trim, collapse internal whitespace; `SHA-256` of the canonical body (research R2)
- [x] T010 [P] Request-state type + allowed transitions in `src/modules/intake/state.ts` (`received→processing→awaiting_pipeline`; `→needs_review`; no AI states)

---

## Phase 3: User Story 1 — Accept once, acknowledge immediately (Priority: P1) 🎯

**Goal**: Atomic message+request+outbox persist; immediate `202` with tracking reference, before background work.

**Independent test**: Submit a valid message → one `messages` + one `requests(received)` + one `job_outbox(pending)` persisted in one transaction; `202` returns `{request_id, state:"received", status_url}`; a partial-failure persists nothing.

- [x] T011 [US1] `IntakeService.submit()` in `src/modules/intake/index.ts`: single transaction writing `messages` + `requests(received)` + `job_outbox(pending)` as `app_user` (tenant from credential); returns `{request_id, state, status_url}` (FR-002/FR-003)
- [x] T012 [US1] `POST /v1/messages` route (shopAuth) returning **`202`** per contract, in `src/modules/intake/routes.ts`, using the 001 typed-route helper
- [x] T013 [US1] Mount intake routes under `/v1` (shopAuth) in the composition root `src/api/app.ts`
- [x] T014 [P] [US1] Integration test: valid submit persists message+request+outbox atomically and returns `202`+`received`; a forced mid-write failure persists nothing (FR-002) in `tests/integration/intake.accept.test.ts`
- [x] T015 [P] [US1] Contract test: `POST /v1/messages` 202 shape and `GET /v1/requests/:id` shape per `contracts/openapi.yaml` in `tests/contract/intake.contract.test.ts`

**Checkpoint**: Messages are accepted once and acknowledged immediately (sit in `received`).

---

## Phase 4: User Story 2 — Duplicates never create duplicate work (Priority: P1)

**Goal**: Idempotency keyed only on `(shop, source, submission_id)`; replay vs `409`; concurrency → one; different ids never merge by content.

**Independent test**: 50 parallel identical submissions → one request; same id + different canonical content → `409`; different ids + identical content → two requests; missing id or content >20,000 chars → `422`.

- [x] T016 [US2] Idempotency in `IntakeService.submit()` (`src/modules/intake/index.ts`): `INSERT … ON CONFLICT (shop_id, source, submission_id) DO NOTHING`; on conflict compare the stored canonical fingerprint — equal → return the existing request's reference (replay), different → `409` (FR-005/FR-006); concurrency relies on the unique-index serialization (FR-007)
- [x] T017 [US2] Request validation in `src/modules/intake/routes.ts`: `source ∈ {email, web, api}`; `submission_id` required/non-empty (**`422`** if missing — never content-hashed, FR-004/FR-015); `content` length **≤ 20,000 characters** (**`422`** if exceeded, deterministically — FR-012)
- [x] T018 [US2] Enforce FR-015 in `src/modules/intake/index.ts`: dedup eligibility is **only** same `(shop, source, submission_id)`; the fingerprint is used solely for conflict detection, never as a dedup key — no content-keyed path exists
- [x] T019 [P] [US2] Integration test: 50 parallel posts of `m-1003` (same shop/source/id) → exactly **one** request and one outbox row (SC-002) in `tests/integration/intake.idempotency.test.ts`
- [x] T020 [P] [US2] Integration test: same id + different canonical content → `409` (original unchanged); whitespace-only difference → replay, **not** `409` (SC-003, research R2) in `tests/integration/intake.conflict.test.ts`
- [x] T021 [P] [US2] Integration test: two different `submission_id`s with identical content → **two** requests (SC-008); missing `submission_id` → `422`; `content` >20,000 chars → `422` in `tests/integration/intake.distinct.test.ts`

**Checkpoint**: US1 + US2 is the MVP — messages accepted exactly once with correct dedup/conflict.

---

## Phase 5: User Story 3 — Background processing with recovery (Priority: P2)

**Goal**: Worker consumes jobs (ids only), advances state idempotently; relay drains outbox; **pg-boss owns retries** (3 total attempts); the reconciler aligns status without re-scheduling; nothing lost; poison parks `needs_review`.

**Independent test**: redelivery → no second effect; worker crash → **pg-boss redelivers**, request reaches `awaiting_pipeline`, zero loss; a persistently failing job → `needs_review` after 3 pg-boss attempts (no app-level retry loop); emptied queue → outbox delivery rebuilt from durable state; worker runs as `app_user` under RLS.

- [x] T022 [US3] Activate `src/worker/index.ts`: start the `JobQueue`, relay, processor, and sweeper (log **ids only**, FR-018)
- [x] T023 [US3] Relay in `src/worker/relay.ts`: claim `job_outbox(pending)` rows, publish `{request_id, shop_id}` to pg-boss, mark `published` (idempotent; safe to re-run)
- [x] T024 [US3] Processor in `src/worker/processor.ts`: consume a job, open a tenant-bound tx (`set_config('app.tenant_id', shop_id, true)` as `app_user`), advance `received → processing → awaiting_pipeline` **idempotently** (no-op if already `awaiting_pipeline` — so pg-boss redelivery/replay yields no duplicate, FR-009). On failure it **throws** so pg-boss schedules the retry — the processor does **not** re-enqueue. It records `requests.attempts`/`processing_started_at` for observability only; pg-boss owns the attempt limit.
- [x] T025 [US3] Reconciler in `src/worker/sweeper.ts` — reconciles request status with durable queue state; it **does NOT retry or re-enqueue work pg-boss is already managing** (no second retry loop, FR-011). It MAY: (a) re-run **outbox delivery** for any `job_outbox` row still `pending` (delivery, not retry — FR-010 rebuild from durable state); (b) on pg-boss **retry exhaustion** (its dead-letter / failed-completion state), preserve the intake record and transition the request to the visible `needs_review` state. Retry scheduling, backoff, and the attempt limit remain entirely with pg-boss (T008).
- [x] T026 [P] [US3] Integration test: a redelivered/replayed job produces no second effect (SC-004) in `tests/integration/worker.idempotent.test.ts`
- [x] T027 [P] [US3] Integration test: worker crash mid-processing → **pg-boss redelivers** (lease expiration) and the request reaches `awaiting_pipeline` with zero loss and no duplicate logical request; a job that keeps failing parks `needs_review` after **3** pg-boss attempts and never loops; assert there is **no application-level re-enqueue** beyond pg-boss (the reconciler schedules no retries) (SC-005, FR-011) in `tests/integration/worker.recovery.test.ts`
- [x] T028 [P] [US3] Integration test: queue emptied → pending work rebuilt from `requests` state (FR-010) in `tests/integration/worker.rebuild.test.ts`
- [x] T029 [P] [US3] Integration test: the worker processes as `app_user` under forced RLS (tenant-bound); pg-boss schema is owned by the migrator, not `app_user` (research R5) in `tests/integration/worker.rls.test.ts`

**Checkpoint**: Accepted messages reliably reach `awaiting_pipeline`; nothing is lost; poison work is visible.

---

## Phase 6: User Story 4 — Look up a request's status (Priority: P2)

**Goal**: Fetch a request's state by reference, tenant-scoped.

**Independent test**: status returns the state for the owning shop; another shop's credential → `404`.

- [x] T030 [US4] `GET /v1/requests/:id` (shopAuth) returning the request's state, read as `app_user` bound to the caller's shop (RLS), in `src/modules/intake/routes.ts`
- [x] T031 [P] [US4] Integration test: status by reference returns state for the owner; a different shop's credential → `404` (RLS; indistinguishable from not-found) (SC-006) in `tests/integration/intake.status.test.ts`

**Checkpoint**: The acknowledgement's status promise is real and isolation-safe.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T032 [P] Privacy test (FR-018/SC-009): submit a message with distinctive content/email; assert emitted logs/traces contain **no** raw content, email, or credential — only ids/source/state/timestamps — in `tests/integration/intake.privacy.test.ts`
- [x] T033 [P] Confirm the 001 route-schema contract test still passes with the new `/v1/messages` and `/v1/requests/:id` routes (both declared via the typed-route helper, D12) — extend `tests/contract/route-schema.test.ts` if needed
- [x] T034 [P] Update `README.md`: intake usage (submit → `202` → status), the idempotency key, and the no-AI / `awaiting_pipeline` boundary of this slice
- [x] T035 Scope-guard verification: confirm no AI/LLM, work-order, pricing, email, web-form UI, or semantic/content dedup was introduced (FR-013/FR-015); the worker performs only the deterministic step
- [x] T036 Reuse verification: intake/worker reuse the 001 platform (`shopAuth`, `Db.withTenant` + roles, typed config, pino logger, migration runner) with no duplicated infrastructure

---

## Dependencies & completion order

- **Setup (P1)** → **Foundational (P2)** block everything (migration, config, JobQueue port + adapter, canonical helper, state type).
- **US1 (P3)** depends on Foundational; accepts + persists + `202` (requests sit in `received`), testable without the worker.
- **US2 (P4)** depends on US1's `submit()` path + the unique key from T005; adds idempotency/validation.
- **US3 (P5)** depends on Foundational (JobQueue, outbox, config) + US1 (requests/outbox exist); activates the worker.
- **US4 (P6)** depends on US1 (requests exist); independent of US2/US3.
- **Polish (P7)** depends on all stories.

Story independence: US1+US2 deliver value without the worker (requests in `received`); US3 makes them
reach `awaiting_pipeline` and adds recovery; US4 is an independent read.

## Parallel execution examples

- **Setup**: T002/T003/T004 `[P]` after T001.
- **Foundational**: T009/T010 `[P]` after the migration + config/port land.
- **US1**: tests T014/T015 `[P]` once the route exists.
- **US2**: tests T019/T020/T021 `[P]` once T016/T017 land.
- **US3**: tests T026/T027/T028/T029 `[P]` once the worker pieces exist.
- **Polish**: T032/T033/T034 `[P]`.

## Implementation strategy (MVP first, incremental)

1. **MVP = Setup + Foundational + US1 + US2**: accept each message **exactly once** with correct
   idempotency/conflict handling (requests persisted in `received`). This is the brief's core "hard
   part" (async + duplicates) and the half-weight failure-handling area.
2. **+ US3**: activate the worker so accepted messages reliably reach `awaiting_pipeline`, with
   crash recovery, bounded retries, and no loss.
3. **+ US4 + Polish**: status lookup, privacy scan, scope/reuse verification, README.
4. Every slice boundary ends with a running system and passing tests (Constitution IX / slice loop).

## Requirement → task coverage (every FR has a task; every guarantee has a test)

| FR / SC | Task(s) |
|---|---|
| FR-001 intake auth (shop from credential) | T011, T012, T013 |
| FR-002 atomic persist | T011, T014 |
| FR-003 immediate 202 | T012, T015 |
| FR-004 required submission id / provenance | T017, T021 |
| FR-005 / SC-002 idempotency replay + concurrency | T016, T019 |
| FR-006 / SC-003 conflict → 409 | T016, T020 |
| FR-007 concurrent → one | T016, T019 |
| FR-008 lifecycle state | T005, T010, T024 |
| FR-009 / SC-004 idempotent worker | T024, T026 |
| FR-010 rebuild from request state | T025, T028 |
| FR-011 / SC-005 bounded retries (3) + park | T008, T025, T027 |
| FR-012 ≤20,000 chars, deterministic reject | T017, T021 |
| FR-013 no AI (scope) | T035 |
| FR-014 / SC-006 isolation | T005, T030, T031 |
| FR-015 / SC-008 no content dedup | T018, T021 |
| FR-016 internal UUID PK | T005, T011 |
| FR-017 replies correlated (forward) | T010 (state), T035 (scope note) |
| FR-018 / SC-009 no sensitive logs | T022, T032 |
| SC-001 immediate ack | T014, T015 |
| SC-007 no AI interaction | T035 |
