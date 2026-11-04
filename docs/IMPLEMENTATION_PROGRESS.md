# Implementation Progress — Riverbend

Actual, evidence-backed status. "Done" means code + passing tests (and, where noted, a live run).
Updated as slices progress.

## Summary

| Slice | Spec | Plan | Tasks | Implemented | Tests | Converged | Committed |
|-------|------|------|-------|-------------|-------|-----------|-----------|
| 001-foundation | ✅ | ✅ | 61/61 | ✅ | ✅ 27 | ✅ | ✅ `b6dd646` |
| 002-intake-queue | ✅ | ✅ | 36/36 | ✅ | ✅ 13 | ✅ | ✅ `4df4cfd` |
| 003-ai-pipeline | ✅ | ✅ | ✅ | ✅ (fake gateway) | ✅ 23 | ✅* | `b377d86` |
| 004-orders-staff | ✅ | ✅ | ✅ | ✅ | ✅ 6 | ✅ | `64233a9` |
| 005-web-form | — | — | — | — | — | — | — |
| 006-email | — | — | — | — | — | — | — |
| 007-resilience | — | — | — | — | — | — | — |
| 008-eval-and-deploy | — | — | — | — | — | — | — |

## Test commands & last result

- `npm run typecheck` → clean
- `npm run lint` (dependency-cruiser) → 0 violations
- `npm test` (Vitest + Testcontainers, real PostgreSQL; Docker required) → **69 passed / 69**
- Live: `make up` → api + worker + db ready; intake smoke verified through real pg-boss.

## Blockers

- **B1** real LLM credentials (blocks 003 real-provider run + 008 live 40-sample eval/cost).
- **B2** GCP account (blocks 008 live deploy; IaC + `terraform validate` still produced).

See [AUTONOMOUS_DECISIONS.md](./AUTONOMOUS_DECISIONS.md) for rationale.

## 003-ai-pipeline — detailed status (PARTIAL, honest)

**Done + tested (checkpoint 1):**
- `LlmGateway` port + deterministic `FakeGateway` + `LiteLlmGateway` stub (refuses to run without
  credentials — B1, never faked).
- Extraction schema + validation (**I3**): malformed output and unknown catalog codes rejected
  (`tests/unit/extraction.test.ts`, 4 tests).
- Budget reserve-then-settle ledger (**I4**): atomic reserve, replay-safe receipts (no double charge),
  settle, reap, RLS — `migrations/4000_budget.cjs` + `modules/budget` (`tests/integration/budget.test.ts`,
  5 tests incl. 20-concurrent-vs-cap-of-5 → exactly 5, replay reuse, reap, isolation).

**Remaining in 003 (NOT built; do not treat as done):**
- Decision logic (`modules/pipeline/decide.ts`): wrong-shop → needs_review, price-inquiry → answered,
  delegation → general inspection, required-field check.
- One follow-up question (I6) with DB `CHECK ≤ 1` + reply resumption (new tables extractions/follow_ups).
- Worker wiring: `processor.ts` to run reserve → extract → validate → settle → decide → set state
  (currently still the 002 no-op to `awaiting_pipeline`).
- Real-provider extraction run + the 40-sample eval + cost report — **gated on B1**.

## Current feature

**001–008 implemented + committed. 88/88 tests; typecheck + lint clean.**

- 001–004 as before (foundation, intake/queue, AI pipeline, orders).
- Real OpenAI inference through the approved LiteLLM-proxy architecture (verified live end-to-end).
- Constitution amended to **1.2.0** (I4 → LiteLLM-native budgets, D7 reversal, FR-007 rewrite); the
  verifiable migration pieces (real cost capture, fail-closed held_budget) are in, legacy ledger stays
  the active authority (native sole-authority cutover deferred — can't validate atomicity without paid
  budget-exhaustion calls; see [decision-log.md](./decision-log.md) + [AUTONOMOUS_DECISIONS.md](./AUTONOMOUS_DECISIONS.md)).
- 005 web form, 006 email (Resend, D21 — Mailpit retired), 007 resilience (breaker/bulkhead/AI-paused) — lean specs under
  `specs/00X-*/spec.md`.
- 008 eval harness → real [results.md](./results.md) (deterministic 40-message run); GCP Terraform
  IaC **validated** (Terraform 1.17.1), CI runs `terraform validate`; README + [architecture note](./ARCHITECTURE_NOTE.md).

**Gated / deferred (not fabricated):** live 40-message eval + real provider cost (B1); LiteLLM-native
sole-authority cutover; verified-channel cancellation + staff HTML; OpenTelemetry/retention sweeper;
live GCP deploy (B2). See [AUTONOMOUS_HANDOFF.md](./AUTONOMOUS_HANDOFF.md).
## Feature 009 — secure API access + OpenAPI + local ops (2026-11-04)

Credential lifecycle on the existing shop-API-key model: scopes (empty=unrestricted), expiry (→401),
rotation, masked listing, ids-only `credential_audit`. OpenAPI 3 + Swagger UI at `/docs` (non-prod).
`make provision` for no-SQL local setup (idempotent). ADMIN_BOOTSTRAP_TOKEN unchanged. LiteLLM virtual
keys never exposed. Tests: **112/112**. Spec: `specs/009-api-access-docs/spec.md`; decision: D19.

## Feature 010 — staff auth portal (2026-11-04): SPEC + FOUNDATION only (honest)

- **Spec Kit reconciliation done:** reconstructed `specs/008-eval-deploy/spec.md` (from real code, no
  invented results); added `specs/010-staff-auth-portal/` spec + plan + tasks; D20 + decision-log.
- **Verified foundation committed:** `shop_membership` + singleton `auth_bootstrap` migration + tests
  (115/115, build green). Auth decision: **Better Auth 1.7.16 (MIT)**, pg adapter, admin() plugin.
- **NOT implemented (large remaining effort; NOT fabricated):** Better Auth install (needs
  `--legacy-peer-deps` — SvelteKit optional-peer/vite conflict), auth-schema migration, Express mount,
  one-time admin init, admin + staff portal UI, ~40 auth/authz/UI tests, real-AI browser smoke. Exact
  ordered steps in `specs/010-staff-auth-portal/tasks.md`. Reason: a full library-backed auth system +
  server-rendered portal cannot be implemented AND verified in one session, and unverified auth code /
  a fabricated browser smoke would violate the honesty mandate.

## Feature 010 — staff auth portal IMPLEMENTED (2026-11-04, slices A–D)

Better Auth 1.7.16 integrated (email/password + sessions + admin plugin, pg adapter; signup disabled;
schema via official CLI → migration 10100). Riverbend authorization via shop_membership (migration
10000) → forced RLS. Admin/staff server-rendered portal (/admin/*, /staff/*): one-time bootstrap-gated
admin init, admin-created staff, shop-scoped console (requests/orders/needs-attention/usage), disable →
session revoke + relogin blocked. Feature 009 shop API keys + Swagger unchanged. **123/123 tests**
(auth, authz, shop-scoping, escaping/no-secrets, regression), typecheck + lint clean.
**NOT run: the real-AI browser smoke (T054)** — flows verified by automated real-Postgres tests, not a
browser session. See specs/010-staff-auth-portal/tasks.md.

## CHECKPOINT 2026-11-04 — completed / incomplete / blocked

**Completed + verified (123/123 tests, typecheck+lint clean, all committed):**
- 001 foundation, 002 intake/queue, 003 AI pipeline (+ real OpenAI via LiteLLM proxy), 004 orders.
- 005 web form, 006 email (Resend + Svix inbound webhook + content fetch + reply correlation, D21), 007 resilience
  (breaker/bulkhead/AI-paused).
- 008 eval harness (deterministic docs/results.md + real docs/results-live.md) + Terraform (validated).
- Correctness guards (m-1025/m-1009/m-1032) — real-eval defects fixed deterministically.
- 009 API-key lifecycle (scopes/expiry/rotation/masked-list/audit) + OpenAPI/Swagger + `make provision`.
- 010 staff auth portal: Better Auth installed+wired, admin/staff email-password login WORKS (tests),
  shop-scoped console, disable→revoke, API keys preserved.

**Incomplete:**
- 010 T054 real-AI **browser** smoke (automated tests pass; no browser session run) — the exact next task.
- 010 polish: multi-shop selector UI, credential-replace UI.
- Minor: Better Auth on a dedicated restricted DB role (prod hardening); OTel/retention sweeper (007).

**Blocked (external / env, not code):**
- Live 40-message eval real-cost beyond the demo run (B1 — needs the standing OpenAI key + budget).
- Live GCP deploy (B2 — IaC validated, no `apply`).
- Host `localhost:5432` port conflict blocks host-run commands against the compose DB (remap or free 5432).

## CHECKPOINT 2026-11-04 (D21) — Feature 006 migrated to Resend (sole email provider)

- **Completed + verified:** Resend outbound (`ResendTransport`, idempotency, bounded retry/backoff,
  delivery-status), Svix-signed inbound webhook `POST /webhooks/resend` (durable `email_events`, dedup by
  svix-id), worker drains events + fetches content via `emails.receiving.get` + existing correlation,
  monotonic delivery status. Mailpit/SMTP/nodemailer removed. Migration `11000_resend_email.cjs`.
  Spec Kit 006 amended (spec/research/plan/data-model/contracts/tasks/quickstart/checklist). Docs + D21 +
  Terraform reconciled. `npm run typecheck` + `npm run lint` clean; `npx vitest run` **129/129**;
  `docker compose config` valid (services: api, db, worker; +litellm under the llm profile);
  `terraform validate` ✅.
- **BLOCKED (external):** real-provider verification (TEST C, full two-way customer round) needs
  `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET` + a verified sending domain + public webhook URL. Exact
  manual steps in `specs/006-email/quickstart.md`. Not fabricated.
