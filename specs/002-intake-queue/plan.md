# Implementation Plan: Intake & Durable Queue

**Branch**: `002-intake-queue` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-intake-queue/spec.md`

## Summary

Accept inbound messages reliably and never lose them, with **no AI** (interpretation is slice 003).
On a valid submission the service writes the **message + request + a durable job-intent in one
transaction** (a transactional outbox), then returns **`202 Accepted`** with the request id and a
status endpoint — before any background work. Idempotency is keyed **only** on
`(shop, source, submission_id)` via a unique index + `INSERT … ON CONFLICT`: same key + identical
canonical content replays the existing request; same key + different content is **`409`**; different
keys are always distinct (never merged by content). A **worker** (the 001 placeholder, now active)
consumes jobs through a **`JobQueue` interface backed by pg-boss** (D4), binds the tenant, and
advances the request `received → processing → awaiting_pipeline` idempotently. A **relay** drains the
outbox into pg-boss. **pg-boss is the single authority for retries** — leasing, failure, expiration,
backoff, and attempt limits (**3 total attempts**, including the first); on a worker crash pg-boss
redelivers via lease expiration, and after retry exhaustion the intake record is preserved and the
request transitions to a visible `needs_review` state. A **reconciler** aligns request status with
durable queue state and re-runs outbox *delivery*, but **never schedules its own retries** — so **no
accepted message is ever lost** without a competing retry loop. All of it reuses 001's auth, DB roles,
forced RLS, config, and HTTP platform.
This is the first slice that stores **customer message text**, so Principle VII (never log message
text) becomes active.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 22 LTS (inherited from 001).

**Primary Dependencies**: Express 5 + Zod, `pg`, `node-pg-migrate` (all from 001); **new: `pg-boss`**
(job queue, in the same PostgreSQL, behind our own `JobQueue` interface — D4). No AI/LLM, email, or
web-form dependencies (slices 003/005/006).

**Storage**: PostgreSQL 16 (from 001). New tables `messages`, `requests`, `job_outbox`, each carrying
`shop_id` with RLS **enabled and forced** and tenant/admin policies matching 001's pattern. pg-boss
owns its own `pgboss` schema (its queue tables); it is a dispatcher/doorbell, not the system of record.

**Testing**: Vitest + `supertest` + Testcontainers real PostgreSQL (from 001). New focus: idempotency/
concurrency (50 parallel `m-1003` → one request), crash-and-replay (no loss, no double-process), and
409/isolation. No fake AI server needed (no model in this slice).

**Target Platform**: Linux container; local `docker compose` (the 001 compose gains the worker process).

**Project Type**: Backend web-service, modular monolith (from 001). The **worker** process becomes
active in this slice (consume + relay + sweep); the **api** process still never does slow work.

**Performance Goals**: Not a throughput slice. Intake returns `202` effectively instantly (before
background work); the job lease/expiration (pg-boss `expireInSeconds`) that drives crash recovery is
configurable and set above worst-case run time.

**Constraints**: One-transaction atomic intake (D3); shop identity from the credential only (001);
money/AI absent; **message content MUST NOT be logged** (Principle VII); idempotency never keys on
content (FR-015); worker processing idempotent; proportional to the take-home (no infra beyond pg-boss).

**Scale/Scope**: 3 shops; the 39-distinct-id/40-delivery sample set (incl. duplicate `m-1003`); a
handful of endpoints (submit message, read request status). "Breaks first at 100 shops" is slice 008.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution v1.1.0. Principles exercised by this slice:

| Principle / Invariant | Applies? | How this plan satisfies it |
|---|---|---|
| I. Code owns money & decisions | Partial | No AI, no money, no decisions. The worker is a deterministic state-advancer; the model is introduced in 003. |
| II. Invariants always hold | Partial | No new numbered invariant lands here (I2 work-order uniqueness is slice 004). The 002 analog — one request per `(shop, source, submission_id)` — gets a unique-index + concurrency test. I1/I7 continue to hold. |
| III. Database-enforced isolation (NON-NEGOTIABLE) | **Yes** | New tables `messages`/`requests`/`job_outbox` carry `shop_id`, RLS enabled+forced, tenant policy for `app_user`; 001's policy build-check (FR-004) fails if any is unpoliced. Status reads and worker processing bind tenant via `set_config`. |
| IV. Ports and adapters | **Yes** | pg-boss sits behind a `JobQueue` interface in `platform/queue`; modules talk via public `index.ts`; `dependency-cruiser` rules extended to the new modules. |
| V. One-way & two-way doors | Yes | One-way (recorded, D3): idempotency key + `202`/`409` public contract. Two-way (behind interface): pg-boss as the queue. |
| VI. Failure is normal | **Yes — core** | Immediate `202` before slow work; one-transaction durable write; **pg-boss owns bounded retries + backoff + redelivery** (single authority, 3 attempts); the reconciler aligns status and re-runs outbox delivery without re-scheduling; poison work parks in a visible `needs_review`; "no accepted message is ever lost" is the headline guarantee. |
| VII. Privacy by default | **Yes — newly active** | This slice first stores **customer message text**. Logs/traces MUST NOT contain message content (pino logger already omits it); only ids (request/shop/submission) are logged. |
| VIII. Tests prove the risky parts | **Yes** | Idempotency/concurrency, crash-replay, and isolation tests run against **real PostgreSQL** (Testcontainers). No model ⇒ no fake-AI server. |
| IX. Honesty about scope | Yes | The slice ends at `awaiting_pipeline` and does **not** pretend AI extraction occurred; README notes the boundary. |

**Gate result (pre-Phase 0): PASS.** No violations; Complexity Tracking empty.

**Re-check (post-Phase 1 design): PASS.** The design keeps every guarantee: the new tables carry
`shop_id` + forced RLS (III), with the worker binding tenant per job so RLS holds during processing;
pg-boss sits behind the `JobQueue` port (IV); the transactional outbox + **pg-boss's durable retry/
redelivery (the single retry authority)** make "no accepted message is ever lost" structural, not
best-effort (VI), with the reconciler aligning state but never re-scheduling retries; logging is ids-only so customer text is never
written (VII); idempotency keys on the identifier, never content (no semantic dedup); and the slice
stops at `awaiting_pipeline` with no AI (IX). pg-boss's elevated schema privileges are confined to the
owner/migrator connection, not `app_user`. One item to confirm at implementation (research R5, guide
Appendix E): pg-boss install/schema privileges under the 001 role split — a test asserts the worker
still processes as `app_user` under RLS. No new violation; Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/002-intake-queue/
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── openapi.yaml      # Phase 1 (submit message, read request status)
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks (NOT created here)
```

### Source Code (repository root) — additions to the 001 layout

```text
src/
├── platform/
│   └── queue/                 # NEW: JobQueue interface + pg-boss adapter (D4, Principle IV)
│       ├── index.ts           # JobQueue port: publish(job), work(name, handler), start/stop
│       └── pgboss-adapter.ts   # pg-boss implementation (own schema; digest-pinned image in prod)
├── modules/
│   └── intake/                # NEW: accept → dedupe → persist (message+request+outbox) → status
│       ├── index.ts           # IntakeService: submit(), getRequestStatus(), canonicalize()+fingerprint
│       └── routes.ts          # POST /v1/messages (202/409/422), GET /v1/requests/:id
├── worker/
│   ├── index.ts               # NOW ACTIVE: starts relay + queue worker + sweeper (no AI)
│   ├── relay.ts               # drains job_outbox → pg-boss (at-least-once doorbell)
│   ├── processor.ts           # consumes jobs; binds tenant; received→processing→awaiting_pipeline (idempotent)
│   └── sweeper.ts             # RECONCILER: aligns request status with pg-boss state + re-runs outbox delivery; never retries (pg-boss owns retries)
└── migrations/
    └── 3000_intake.cjs        # messages, requests, job_outbox: shop_id + forced RLS + policies + unique key

tests/
├── integration/
│   ├── intake.idempotency.test.ts   # same key+same content → one; 50 parallel m-1003 → one; 409 on diff content
│   ├── intake.distinct.test.ts      # different keys / identical content → two requests (FR-015)
│   ├── worker.recovery.test.ts      # crash-replay: no loss, no double-process; pg-boss redelivery; poison→needs_review; no app retry loop
│   ├── intake.isolation.test.ts     # cross-tenant submit/status rejected (RLS)
│   └── intake.privacy.test.ts       # message content never appears in emitted logs (VII)
└── contract/
    └── intake.contract.test.ts      # 202 shape + status endpoint + 409 + 422 per openapi.yaml
```

**Structure Decision**: Add a `platform/queue` port (pg-boss behind `JobQueue`), one `intake` module
(message/request/status + idempotency), and activate the `worker` process (relay + processor +
sweeper). The durable job-intent is a `job_outbox` row written atomically with message+request;
pg-boss is the transient dispatcher and the sweeper reconciles from `requests` state, so the queue is
"a doorbell, not the memory" (D4). `dependency-cruiser` boundary rules extend to the new modules (the
api process must not import the worker's processing code; business modules talk only via `index.ts`).

## Complexity Tracking

> No constitution violations to justify. Section intentionally empty.
