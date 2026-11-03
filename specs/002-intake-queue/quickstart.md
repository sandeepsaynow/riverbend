# Quickstart & Validation: 002-intake-queue

A run/validation guide proving intake is reliable and never loses work, with no AI. References
[data-model.md](./data-model.md) and [contracts/openapi.yaml](./contracts/openapi.yaml). No
implementation code here — that lives in `tasks.md` / the implement phase.

## Prerequisites

- Everything from 001 (`make up` brings up PostgreSQL + api; `.env` with the three DB URLs +
  `ADMIN_BOOTSTRAP_TOKEN`). This slice also starts the **worker** process (relay + queue + sweeper)
  and pg-boss (its own schema in the same database).
- A provisioned shop and a shop credential (001 admin flow). Below, `KEY` is a shop credential.

## One-command run

```sh
make up        # 001 stack + worker + pg-boss; applies the 3000_intake migration
make down
```

**Expected**: api ready (001 `/readyz`); the worker logs that it started the relay, queue worker, and
sweeper — logging **ids only**, never message content.

## Validation scenarios

Each maps to FR/SC and becomes an automated test (Vitest + Testcontainers, real PostgreSQL).

### V1 — Accept once + immediate 202 (US1, FR-002/003)

```sh
curl -si -X POST localhost:8080/v1/messages -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"source":"email","submission_id":"m-1003","content":"The chain on my bike keeps slipping."}'
# => 202 Accepted  { request_id, state:"received", status_url }
```

- The message + request + `job_outbox` row are persisted in one transaction; the `202` returns before
  background processing. Shortly after, the worker advances the request to `awaiting_pipeline`.

### V2 — Idempotent replay + duplicate m-1003 (US2, FR-005, SC-002)

- Re-POST the exact same body → **same `request_id`**, no new request/job.
- **50 parallel** POSTs of `m-1003` (same shop/source/id) → **exactly one** request (the brief delivers
  `m-1003` twice to `rb-lakeshore`; this is the canonical duplicate test).

### V3 — Conflict on reused id (US2, FR-006, SC-003)

```sh
# same source+submission_id, different content:
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8080/v1/messages -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"source":"email","submission_id":"m-1003","content":"Actually, it is the brakes."}'   # => 409
```

- The original request is unchanged. A trivial whitespace-only difference does **not** 409 (canonical
  comparison, R2).

### V4 — Different ids never merge by content (FR-015, SC-008)

- Two submissions with **different** `submission_id` but identical content (two customers, or the same
  customer re-booking) → **two** distinct requests.
- Missing `submission_id` → **422** (never content-hashed).

### V5 — Worker recovery, no loss, no double-process (US3, FR-009/010/011, SC-004/005)

- Redeliver a job (or replay the same message) → the idempotent handler produces **no** second effect.
- Kill the worker mid-processing; restart → **pg-boss's lease expiration** redelivers the job (within
  the 3-attempt limit) and it reaches `awaiting_pipeline`. **Zero** accepted messages lost; the app runs
  no retry loop of its own.
- Force repeated failure → after pg-boss exhausts the 3 attempts the request parks in `needs_review`
  (dead-letter/failed state; no infinite loop).
- Empty pg-boss's dispatch records → the **reconciler** re-runs outbox *delivery* from `requests` state
  (FR-010) — delivery, not a processing retry.

### V6 — Status lookup, tenant-scoped (US4, FR-014, SC-006)

```sh
curl -s localhost:8080/v1/requests/<request_id> -H "Authorization: Bearer $KEY"   # => 200 { state }
```

- Another shop's credential requesting that id → **404** (RLS; indistinguishable from not-found).
- A cross-tenant submit (shop id in the body) → ignored; shop comes from the credential.

### V7 — Privacy: no message content in logs (Principle VII)

- Submit a message with distinctive text; scan emitted logs/traces → the text never appears (only ids,
  source, state).

## Done (slice exit criteria)

- `make up` → api ready and worker running; V1–V7 pass as automated tests.
- Constitution gates for 002 hold: isolation on the new tables (V6), failure-handling/no-loss (V5),
  privacy (V7); idempotency/concurrency proven on real PostgreSQL (V2/V3/V4).
- No later-slice capability present: no AI/LLM, no work orders/pricing, no email/web-form UI, no
  semantic duplicate detection. The slice ends at `awaiting_pipeline`.
