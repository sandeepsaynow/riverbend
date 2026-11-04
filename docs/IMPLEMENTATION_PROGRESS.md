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

## CHECKPOINT 2026-11-04 (D21.1) — Feature 006 inbound polling (default local/MVP)

- **Completed + verified:** pg-boss self-rescheduling singleton poll job (`EMAIL_POLL_QUEUE`),
  `EmailService.pollOnce` + durable lease (`email_poll_state`, migration `11100`), `ResendReceiving.list`
  pagination, discovery → existing `processPendingEvents` drain. Webhook preserved, off unless
  `RESEND_WEBHOOK_SECRET` set. Config +`RESEND_POLLING_ENABLED`/`RESEND_POLL_INTERVAL_SECONDS`. Spec Kit 006
  amended (research/spec/plan/data-model/contracts/tasks/quickstart/checklist D21.1 sections). Docs +
  D21.1 reconciled. `typecheck`+`lint` clean; `vitest` **138/138** (9 new polling tests, real PostgreSQL);
  `docker compose config` ok (api/db/worker). No live provider calls.
- **BLOCKED (external):** real end-to-end with a live Resend account (send to a `<id>.resend.app` address and
  observe a real poll) needs `RESEND_API_KEY` + a receiving address; full customer-delivery round needs a
  verified sending domain. Steps in `specs/006-email/quickstart.md`. Not fabricated.

## CHECKPOINT 2026-11-04 (FINAL QA) — ran the real stack; fixed boot blockers; live-AI E2E passed

- **Bugs found + fixed by running the app** (not new features): (1) `docker-compose.yml` did not inject
  `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` into the **api** service → the whole 010 portal was OFF under
  Compose (now injected); (2) `server.ts` constructed `SvixVerifier(RESEND_WEBHOOK_SECRET)` eagerly →
  svix base64-decodes in its constructor, so a malformed **optional** secret **crashed the entire API**
  (now wrapped: bad secret → warn + webhook disabled, fail-closed); (3) poll failures were silent →
  worker now logs `resend inbound poll failed`. Also: `api`/`worker` given `restart: on-failure`
  (self-heal the migrate-before-serve race); `Dockerfile` now ships `scripts/` (in-container provisioning);
  db host port made `${DB_HOST_PORT:-5432}` (avoid the localhost:5432 conflict); added
  `docker-compose.local.yml` (local browser-walkthrough overlay) + `docs/FINAL_MANUAL_TEST.md`.
- **Verified live (Compose, real OpenAI via LiteLLM — NOT FakeGateway):** api `ready`; portal/web-form/
  polling enabled; `/admin/login` 200, `/staff`→302, `/v1/orders`→401. A Downtown request processed to an
  `ordered` work order with catalog prices **$110.00** (CHAIN_REPLACE+TUNE_BASIC, cat-001); Northside
  `/v1/orders` empty (isolation). LiteLLM healthy; worker logged a real `llm extraction` (467 tokens).
- **Regression:** `typecheck`+`lint` clean (91 modules); `vitest` **138/138** (real PostgreSQL);
  `docker compose config` + `+local overlay` + `terraform validate` all valid.
- **Credential reality:** OPENAI_API_KEY valid (200); **RESEND_API_KEY invalid (401)** + RESEND_WEBHOOK_SECRET
  not a valid Svix secret → real Resend outbound/inbound/delivery (B/C/D) **BLOCKED**; deterministic Resend
  integration (A) passes. **T054 browser click-through still manual** (no browser automation); guide written.

## CHECKPOINT 2026-11-04 (LIVE RESEND) — real-provider acceptance + a submission-critical fix

- **D21.2 bug fixed (found by live testing):** the `reply+<token>@` local part was ~142 chars (old string
  token) → Resend **HTTP 422**, so every real clarification failed → `needs_review`. Re-encoded the token
  as raw-byte UUIDs + a 10-byte HMAC in one base64url blob → **62-char** local part (≤64). Same signed
  correlation; `mintReplyToken`/`readReplyToken` signatures unchanged; 138/138 still green.
- **Verified against the REAL Resend account (key in .env):** key valid (200); Receiving list + `get`
  schema match the app; the **live polling worker** discovered a real received email, fetched content, and
  ignored it (unmatched); outbound to `delivered@resend.dev` → 200 + id; and a **real Riverbend
  clarification now SENDS** (outbox `sent`, provider id persisted) where it was 422 before the fix.
- **Still blocked (needs a human):** the customer-reply resumption (D) — reply from a real mailbox to a
  `reply+<token>@karoiechou.resend.app` address; `delivered@resend.dev` can't reply. Full outbound to
  arbitrary customers needs a verified sending domain (currently `onboarding@resend.dev`).
- Regression: typecheck+lint clean; `vitest` **138/138**; stack torn down; host Postgres untouched.

## CHECKPOINT 2026-11-04 (P0 AUTH RECOVERY) — bootstrap atomicity audit + fix

- **P0 fixed (D20.1):** recoverable two-phase first-admin bootstrap. Root cause was a crash between the
  (separate-transaction) Better Auth createUser and the marker UPDATE, plus `isInitialized()` treating any
  marker row as done → permanent 409 lockout. Now: marker carries `admin_email`+`status`, completion ⟺
  `admin_user_id IS NOT NULL`, retries reconcile (create or complete-existing-with-credential), concurrency
  converges on one admin, credential-less orphan → `RecoveryRequired` (operator step). Migration `12000`.
- **Staff creation hardened:** shop verified before identity creation; duplicate-email reconciled only for
  orphan identities (real accounts refused); idempotent membership upsert.
- **Tests:** +16 real-PostgreSQL (11 bootstrap/staff fault-injection + 4 reply-token invariants + 1 outbound
  idempotency-on-retry). Full suite **154/154**; typecheck + lint clean; compose config (default + local
  overlay) + terraform validate ok.
- **Live:** migration 12000 applies; a pre-existing COMPLETED admin correctly yields 409 on re-init and the
  auth gate redirects/401s as expected. Full fresh-init/login/staff/isolation/recovery is proven by the
  automated fault-injection suite (the shared live test db already had a completed admin; not reset per the
  no-destructive-cleanup rule). AI/Resend live paths unchanged since the prior turn.

## CHECKPOINT 2026-11-04 (D20.2) — security re-audit of bootstrap recovery (P0/P1 fixes)

- **P0 unauthorized-adoption fixed:** bootstrap records only a user it created (never adopts an email-matched
  account); duplicate/ambiguous → fail-closed RecoveryRequired. Staff creation never adopts a pre-existing
  account (duplicate → closed; shop verified first; orphan stays non-privileged). DB CHECK
  (12100_bootstrap_consistency.cjs) enforces completion ⟺ admin_user_id present.
- **P1 CSRF fixed:** exact scheme://host:port allowlist (trustedOriginsFor) shared by Better Auth + portal;
  127.0.0.1-vs-localhost rejection resolved without disabling CSRF; foreign/scheme/port/null blocked.
- **Tests:** +13 real-PG (bootstrap/staff ownership + 10 CSRF). Full suite **167/167**; typecheck+lint clean;
  compose (default+overlay) + terraform validate ok. Live: migrations 12000+12100 apply, CSRF 127.0.0.1→401
  / foreign→403, completed-admin→409.
- **Documented prod gap:** Better Auth runtime uses the migrator role; a dedicated restricted role is the
  production recommendation (not shipped unverified near submission).

## CHECKPOINT 2026-11-04 (D20.3) — browser-login 403 fixed with production-grade CSRF

- **Root cause:** Helmet default `Referrer-Policy: no-referrer` → `Origin: null` on same-origin browser form
  POSTs → D20.2 origin guard 403'd them (curl masked it). **Fixed:** Referrer-Policy →
  strict-origin-when-cross-origin + an origin-independent **double-submit CSRF token** (HttpOnly SameSite=Lax
  `rb_csrf` cookie ⇔ hidden `_csrf` field) on all cookie-authed portal POSTs (login/create-staff/disable/
  logout); exact-origin allowlist kept as defense-in-depth; logout migrated GET→POST; `/admin/init` stays
  bootstrap-token-authed (no CSRF).
- **Tests:** csrf-origin suite rewritten to two layers (origin + token) incl. the exact browser-403
  regression (Origin: null + valid token → allowed); portal tests made CSRF-aware. Full suite **170/170**;
  typecheck + lint clean; compose (default + overlay) valid. Live: Referrer-Policy header confirmed;
  Origin:null no-token→403, +token→401; foreign→403.
- **Prod note:** strict single HTTPS origin allowlist; Secure+SameSite cookies; set a trusted reverse-proxy
  `trust proxy` before believing forwarded headers (documented gap).
