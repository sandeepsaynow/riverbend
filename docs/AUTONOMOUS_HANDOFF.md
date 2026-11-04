# Autonomous Handoff — Riverbend

<!-- ============================================================================================= -->
## ✅ CHECKPOINT — 2026-11-04 (read this first; supersedes everything below)

**Git:** branch `004-orders-staff`; **working tree CLEAN** (no uncommitted changes). Latest commits:
`4cdad81` 010D staff pages+docs · `7a3459b` 010BC portal · `3174f6a` 010A Better Auth · `ba1cb5c` 010
identity schema · `df78289` 008 reconstruction + 010 spec/D20 · `dbd5706` 009 · `a77fc3e` eval guards.
Nothing pushed; no deploys.

**Verification (2026-11-04, after D21 Resend migration + D21.1 inbound polling):** `npm run typecheck` ✅ ·
`npm run lint` ✅ (0 violations, 91 modules) · `npx vitest run` → **138 passed / 138** (23 files, real
PostgreSQL via Testcontainers; Docker required) · `docker compose config` ✅ · `terraform validate` ✅.
**No known test failures.**

**FINAL QA (2026-11-04): ran the real Compose stack with real OpenAI.** Fixed 3 real boot bugs — api was
not given `BETTER_AUTH_SECRET` in compose (portal dead); `server.ts` crashed the whole API on a malformed
optional `RESEND_WEBHOOK_SECRET` (svix base64); silent poll failures. Also `restart: on-failure` on api/
worker, `Dockerfile` ships `scripts/`, `${DB_HOST_PORT:-5432}`, added `docker-compose.local.yml` +
`docs/FINAL_MANUAL_TEST.md`. **Live-AI E2E PASSED:** a Downtown request → real OpenAI via LiteLLM →
`ordered`, catalog-priced **$110.00**; Northside isolated. **Credential reality:** OPENAI valid;
**RESEND_API_KEY invalid (401)** + webhook secret not a valid Svix secret → real Resend (B/C/D) BLOCKED
(deterministic Resend tests pass). **T054 browser click-through still manual** — see FINAL_MANUAL_TEST.md.

**Features 001–010 all implemented + committed.** 001 foundation · 002 intake/queue · 003 AI pipeline
(+real OpenAI via LiteLLM proxy) · 004 orders · 005 web form · 006 email (**Resend**, D21) · 007 resilience ·
008 eval+Terraform · 009 API-key lifecycle+Swagger · 010 staff auth portal (Better Auth).

### Authentication state (item 5)
- **Better Auth 1.7.16 (MIT) IS installed** (pinned exact; `@better-auth/cli 1.4.21`; installed with
  `--legacy-peer-deps` for an unused `@sveltejs/kit` optional peer vs dev vite@5 — documented).
- **Admin + staff email/password login WORKS** — proven by automated tests on real PostgreSQL
  (`tests/integration/better-auth.test.ts` + `tests/integration/portal.test.ts`): signup disabled;
  one-time bootstrap-gated admin init; admin creates staff; staff login → HttpOnly session; each staff
  sees ONLY their shop; cross-shop denied; disable → session revoked + relogin blocked; password hashed.
- Config: `src/platform/auth/better-auth.ts` (factory, pg Pool adapter, `admin()` plugin, signup off).
  Mounted in `src/api/app.ts` at `/api/auth/{*any}` BEFORE `express.json`; portal routes in
  `src/api/portal-routes.ts` (mounted BEFORE the 009 admin API router); authz in
  `src/modules/portal/service.ts`. Server builds the instance in `src/api/server.ts` when
  `BETTER_AUTH_SECRET` is set (its own migrator Pool). Tables: migration `10100_better_auth.cjs`
  (user/session/account/verification — global, NOT under tenant RLS); binding: `10000_staff_identity.cjs`
  (`shop_membership` + singleton `auth_bootstrap`).
- **IMPORTANT:** the portal is OFF unless `BETTER_AUTH_SECRET` is set — and the current `.env` does NOT
  have it (nor `EMAIL_SIGNING_KEY`, nor `LLM_MASTER_KEY`). Add them to run the portal/email/native-budget
  live (see item 7). **Not verified:** the real-AI BROWSER smoke (`tasks.md` T054) — automated tests
  only, no browser session was run.

### Feature 006 email state (item 6) — **Resend only (D21, migrated 2026-11-04; Mailpit retired)**
- Files: `src/modules/email/transport.ts` (`EmailTransport` port + `InMemoryEmailTransport` for tests +
  **`ResendTransport`** via the **`resend` 6.37.0** SDK, with `PermanentSendError`/`TransientSendError`),
  `src/modules/email/receiving.ts` (`ReceivingClient` port + `ResendReceiving`),
  `src/modules/email/resend-webhook.ts` (`InboundWebhookVerifier` + **`SvixVerifier`** via `svix` 2.9.1),
  `src/modules/email/tokens.ts` (unchanged HMAC reply tokens), `src/modules/email/index.ts`
  (`EmailService`: enqueueFollowUp + html + idempotency_key, relayPending + bounded retry, ingestEvent,
  processPendingEvents, applyDeliveryStatus, handleInbound). Migrations `7000_email.cjs` (unchanged) +
  **`11000_resend_email.cjs`** (outbox html/idempotency/retry/delivery-status cols + global `email_events`).
- Outbound: worker enqueues the one question at `awaiting_customer`, `EmailService.relayPending(ResendTransport)`
  on the reconciler tick with idempotency key `rb-followup-<request_id>`; transient failure → keep pending
  + backoff; permanent/exhausted → `needs_review` (`email_delivery_failed`); no email → `no_reply_path`.
- Inbound: **`POST /webhooks/resend`** (`src/api/resend-webhook.ts`, **Svix** signature over raw body;
  mounted when `EMAIL_SIGNING_KEY` + `RESEND_WEBHOOK_SECRET` set). Verify → persist `email_events` (dedup
  by svix-id) → 200; worker `processPendingEvents(ResendReceiving)` fetches content via
  `emails.receiving.get` → existing `reply+<token>@` correlation + Message-ID dedupe + one-round. Delivery
  events update a monotonic `delivery_status`.
- **Inbound mode (D21.1):** DEFAULT local/MVP is **Resend API polling** (no webhook/URL/tunnel) — a pg-boss
  self-rescheduling singleton (`EMAIL_POLL_QUEUE`) runs `EmailService.pollOnce(ResendReceiving)` every
  `RESEND_POLL_INTERVAL_SECONDS` (default 60), discovering ids into `email_events` (durable lease +
  `email_poll_state`, migration `11100`); the same `processPendingEvents` drains them. The webhook above is
  OPTIONAL (off unless `RESEND_WEBHOOK_SECRET` set). Files: `receiving.ts` (`ReceivingLister.list`),
  `email/index.ts` (`pollOnce`), `pgboss-adapter.ts` (`workPoll`/`schedulePoll`). Tests:
  `tests/integration/email-poll.test.ts` (9).
- Queue handling unchanged: resumption inserts `job_outbox` → relay → pg-boss → pipeline re-runs (keyed
  `extract-reply`).
- Removed: `mailpit` compose service, `nodemailer`, `MailpitTransport`, `src/api/email-webhook.ts`,
  `MAIL_SMTP_*`/`MAIL_FROM`/`MAIL_REPLY_DOMAIN`/`EMAIL_WEBHOOK_SECRET`.
- Verified by `tests/integration/email.test.ts` (7, fake Resend transport) + `tests/integration/resend-webhook.test.ts`
  (5, real svix-signed fixtures + fake receiving). **No live provider calls.**
- **Email is OFF with the current `.env`** (no `EMAIL_SIGNING_KEY`/`RESEND_API_KEY`); offline uses the
  in-memory no-op transport. Real two-way (TEST C) BLOCKED without creds + a verified domain — see
  `specs/006-email/quickstart.md`.

### Environment variables (item 7) — NAMES ONLY, values never shown
- **In `.env` now:** DATABASE_URL, DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, ADMIN_BOOTSTRAP_TOKEN,
  PORT, LOG_LEVEL, MAX_PROCESSING_ATTEMPTS, QUEUE_EXPIRE_SECONDS, RECONCILER_INTERVAL_MS,
  OPENAI_API_KEY, LITELLM_MASTER_KEY, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, BUDGET_AUTHORITY.
- **MISSING from `.env` (needed to run the respective feature live; see `.env.example`):**
  `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` (portal), `EMAIL_SIGNING_KEY` + `RESEND_API_KEY` +
  `RESEND_FROM` + `RESEND_REPLY_DOMAIN` (email, **D21**; default inbound is **polling, D21.1** — needs no
  webhook. `RESEND_WEBHOOK_SECRET` is OPTIONAL, only for the push webhook; `RESEND_POLL_INTERVAL_SECONDS`
  optional/default 60. The old `EMAIL_WEBHOOK_SECRET`/`MAIL_*` names are gone), `LLM_MASTER_KEY` (native-budget provisioning — note
  `.env` has `LITELLM_MASTER_KEY` but the worker reads `LLM_MASTER_KEY`), `WEB_FORM_SIGNING_KEY` (web
  form). All are optional/fail-closed.
- `.env` is git-ignored and NOT tracked; `.env.example` documents every name with safe placeholders.

### Test commands (item 8)
`npm run typecheck` · `npm run lint` (dependency-cruiser) · `npx vitest run` (needs Docker) → 123/123.
`make eval` (deterministic → docs/results.md) · `make eval-live` (gated real OpenAI). `make up` /
`make provision`. Compose validate: `docker compose config --services` → api db worker;
`docker compose --profile llm config --services` → api db litellm worker.

### Uncommitted changes (item 9)
**None.** Working tree is clean; nothing to preserve or risk losing.

### EXACT NEXT TASK (item 10)
**Feature 010 T054 — the real-AI browser smoke** (the only un-done 010 item). Steps: add the MISSING
env vars above to `.env` (`BETTER_AUTH_SECRET`, `EMAIL_SIGNING_KEY`/`EMAIL_WEBHOOK_SECRET`, `LLM_MASTER_KEY`,
`WEB_FORM_SIGNING_KEY`); `docker compose --profile llm up` (real OpenAI); `POST /admin/init`; then drive
`/admin/login` → create staff for Downtown + Northside → `/staff/login` → dashboard/orders → submit a
real request via `/f/rb-downtown` → confirm it processes + the work order shows in the staff console →
(with Resend configured) clarification reply via the `resend` CLI listener → verify Northside staff can't
see Downtown data. **NOTE:** host
`localhost:5432` currently resolves to a DIFFERENT Postgres than the compose db (port conflict) — resolve
that (or remap the compose db port) before host-run commands against the live stack. Do NOT run paid
budget-exhaustion tests; keep the aggregate cap < $15. Then minor polish: multi-shop selector UI,
credential-replace UI (tasks.md T040/T021 remainder).

<!-- ============================================================================================= -->

## Historical handoff (pre-010; kept for provenance)

**Execution stopped at a single-session size limit, not a blocker.** Slices 001–004 are implemented,
tested, and committed (verified). 005–008 are not started. Nothing below is fabricated; "pending"
means not built.

## Current state (verified)

> **UPDATE 2026-11-04:** 001–008 are now implemented and committed (88/88 tests). This table's
> "005–008 pending" is historical. Real OpenAI inference works through the LiteLLM proxy; the
> constitution is amended to 1.2.0. Remaining work is only the gated/deferred items listed at the end.

| Slice | Status |
|---|---|
| 001–004 | ✅ complete |
| 003 real provider | ✅ live via LiteLLM proxy (budget migration 1.2.0; legacy ledger still authoritative) |
| 005 web form | ✅ |
| 006 email (Mailpit) | ✅ |
| 007 resilience (breaker/bulkhead/paused) | ✅ core |
| 008 eval + Terraform | ✅ deterministic eval (results.md) + validated IaC; live eval + deploy gated |

### Remaining (gated/deferred — not blockers for the mandatory deliverables)
- **B1**: `make eval-live` (paid 40-message run) + real provider cost in results.md.
- **LiteLLM-native budget sole-authority**: per-shop team/virtual-key provisioning + the
  "N concurrent → exactly K" acceptance test (needs a zero-cost enforcement harness, else paid calls).
- Verified-channel cancellation (m-1038) + server-rendered staff HTML (D9/D17).
- OpenTelemetry/Phoenix tracing, alert set, retention/TTL sweeper (007).
- **B2**: live GCP deploy (IaC validated; `terraform apply` only).

### Historical (original 005–008 plan)

Branch: `004-orders-staff` (each slice branched off the prior). Tests: `npm test` → **69/69** on real
PostgreSQL (Docker). `npm run typecheck` + `npm run lint` clean. Live flow verified via `make up`:
message → `202` → dedupe/409 → worker (intake → ai-pipeline → orders) → `ordered`; `GET /v1/orders`
returns the code-priced order.

## How to resume (exact commands)

```sh
# verify current state
docker info >/dev/null 2>&1 || open -a Docker        # Docker must be running for tests
npm install
npm run typecheck && npm run lint && npm test         # expect 69 passed
ADMIN_BOOTSTRAP_TOKEN=local-dev-admin-secret make up  # api + worker + pg-boss + Postgres
make down
```

Each new slice: `git checkout -b 00X-name` off the previous branch; write `specs/00X-name/spec.md`
(+ lean plan) grounded in `docs/ARCHITECTURE_DECISIONS.md` + `docs/EDGE_CASES.md`; implement in
`src/modules/<name>` reusing the platform; add real-PostgreSQL tests under `tests/`; keep
typecheck/lint/tests green; commit; update `docs/IMPLEMENTATION_PROGRESS.md` + `AUTONOMOUS_DECISIONS.md`.

## Next actions, in priority order

### 005 — web form (D11)  [no external deps]
- Hosted per-shop form reusing the 002 intake path. Public submission endpoint (shop selected by a
  public shop key / slug, not a secret), **mandatory email field**, browser-generated UUID as the
  `submission_id` so a refresh/retry is idempotent (reuse 002's `(shop, source='web', submission_id)`).
- Server-side defences: origin allowlist + CORS, per-IP/per-shop rate limits (reuse express-rate-limit),
  honeypot, size limits, strict validation, output encoding/CSP. Bot-check (Turnstile) is server-side
  verified — stub the verifier behind an interface (no key needed; a fake passes in tests), real key gated.
- Status page + magic-link read (reuse `GET /v1/requests/:id` via a signed status token).
- Tests: double-submit → one request; honeypot/oversize/bad-origin rejected; missing email → 422.

### 006 — email (D10)  [local: Mailpit; no production creds]
- `EmailTransport` port + Mailpit adapter (docker-compose service `mailpit`). Outbox table for outbound
  (reuse the transactional-outbox pattern) → send the one follow-up question (from 003 `follow_ups`).
- Inbound: a signed webhook adapter; match replies by a signed `reply+<token>@` address +
  `In-Reply-To`/`References`; strip quoted text; de-dup by `Message-ID`. On reply → call
  `PipelineService.applyReply` + enqueue a pipeline job with `isReply` (003 already supports this).
- Failed send → needs_review ("delivery failed"); order never rolled back.
- Tests: m-1027 reply resumes by email (Mailpit); failed send parks needs_review.

### 007 — resilience (D13/D15/D16)  [no external deps]
- Timeouts + circuit breaker + per-shop bulkhead around `LlmGateway`; the "AI paused" switch; the
  outage demo (fake gateway returns 503 → retry/park/drain) and the cap demo (tiny cap → held_budget).
- OpenTelemetry (Phoenix local) tracing; the eight alerts; retention job; PII redaction in traces.
- Note: pg-boss already owns retries (003); add the breaker/bulkhead/timeout around the model call only.
- Tests: timeouts/503 retry then park; crash after AI call → no second charge (receipt reuse already works).

### 008 — eval + deploy (D18 / Part 7)  [eval real-run gated on B1; GCP gated on B2]
- Evaluation runner: replay the brief's 40 sample deliveries through the HTTP API, answer follow-ups
  like a customer, write `docs/results.md` (outcome, services, total, AI cost micros, latency per msg),
  score vs a golden set. `make eval` uses recorded/fake answers (free, deterministic, CI). `make eval-live`
  uses the real provider (**B1**, costs money, ledger-tracked, < USD 20) — leave clearly pending.
- Terraform (Cloud Run api + worker pool, Cloud SQL, Vertex AI, Secret Manager, Artifact Registry, LB +
  Cloud Armor, internal LiteLLM) + GitHub Actions via Workload Identity Federation; CI runs
  `terraform validate` + `plan` — **no live deploy (B2)**.
- README: honest hours, not-built list, "what breaks first at 100 shops"; 2-page architecture note.

## Blockers (external; do not fake)
- **B1** real LLM credentials → 003 real-provider run + the live 40-sample eval + real cost report.
- **B2** GCP account → live deploy (IaC + `terraform validate` still produced in 008).

## Guardrails to preserve (all currently honored)
No cross-tenant access (forced RLS, every table); no content/email/session-based dedup (submission-id
only); no duplicate work orders (unique (shop,request,bike) = I2); no invented prices (code + catalog
snapshot = I5); no unvalidated LLM output persisted (I3); one clarification (UNIQUE follow_up = I6);
pg-boss the sole retry authority; spend in micros under a per-shop cap (I4); no secrets in Git;
ids-only logging (no customer text).

**LIVE RESEND (2026-11-04):** real key in `.env` is valid. Fixed D21.2 — the `reply+<token>@` local part
(~142 chars, old string token) hit Resend's RFC-64 limit → HTTP 422, failing every real clarification;
re-encoded as raw-byte UUIDs + 10-byte HMAC (62-char local part), signatures unchanged, 138/138 green.
Verified live: key 200; Receiving list+get schema match; live polling worker discovered+ignored a real
email; outbound to delivered@resend.dev 200+id; a **real clarification now sends** (outbox `sent`, provider
id). BLOCKED-pending-user: the customer-reply resumption (reply to a `reply+<token>@karoiechou.resend.app`
address) + arbitrary-recipient delivery (needs a verified sending domain; from is onboarding@resend.dev).
