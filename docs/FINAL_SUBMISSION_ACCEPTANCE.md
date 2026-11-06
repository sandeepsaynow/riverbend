# Riverbend — Final Submission Acceptance Matrix

Audited **2026-11-06** against the **actual code** (three independent source audits + direct reading), not
documentation. Legend: **PASS** (implemented + evidence) · **PARTIAL** (works, named gap) · **NOT VERIFIED**
(needs external credentials/authorization — never fabricated) · **FAIL** (concrete defect). Test baseline:
`npx vitest run` → **222 passed / 222** (35 files, real PostgreSQL via Testcontainers), typecheck + lint clean.
**Production model (D26, 2026-11-06):** `openai/gpt-5.4-mini-2026-03-17` (upgraded from gpt-4o-mini; config-only
rollback). See `docs/MODEL_COST_REPORT.md` and `docs/TEST_RESULTS.md`.

**GCP status (2026-11-06):** staging was **deployed + end-to-end verified** (`riverbend-staging`) then **torn
down** (no resources running; project + billing preserved) — reproduce with `make gcp-deploy ENV=staging`.
Rows 21/25 "live staging" = verified-then-torn-down evidence, not a running environment. Production LB/HA shape
is Terraform-validated, **not applied**.

| # | Requirement | Actual implementation (evidence) | Tests | Live evidence | Verdict | Remaining gap |
|--:|---|---|---|---|---|---|
| 1 | Git repo + meaningful tests | `main` on GitHub; 222 tests on real Postgres | 35 files | — | **PASS** | — |
| 2 | One-command local startup | `docker compose up --build` / `make up`; `compose config -q` valid (default + local overlay) | compose-validate CI | boots healthy (earlier runs) | **PASS** | host `:5432` → local overlay |
| 3 | Web intake | `src/api/web-routes.ts` + `src/modules/web`, signed form, status page | `web`, `web-idempotency` | — | **PASS** | — |
| 4 | **New inbound email → new request** | **D25:** `EmailService.handleNewInbound` routes by `shops.inbound_address` (migration `13000`), submits via `IntakeService`; separate from reply-resume | `email-new-inbound` (9) | fixtures (not live inbox) | **PASS** | real per-shop verified addresses needed in prod; dedup needs stable Message-ID |
| 5 | Reply to clarification resumes request | `EmailService.resumeReply` (signed `reply+<token>`), one round, Message-ID dedup | `email`, `email-poll` | prior live D21.2 | **PASS** | — |
| 6 | Per-message shop tagging / tenancy | every shop table `shop_id`; `withTenant` | `portal`, `foundation` | — | **PASS** | — |
| 7 | Asynchronous processing | `job_outbox → relay → pg-boss → worker` | `intake`, `pipeline` | — | **PASS** | — |
| 8 | Idempotency (dup delivery → 1 order) | `messages UNIQUE(shop_id,source,submission_id)`, `requests_message_uniq`, `work_orders_one_per_bike` | `intake` (50-concurrent), `orders` | — | **PASS** | — |
| 9 | Web multi-submit / same-browser | fresh operation-id per load (D24), BFCache regen, PRG | `web-idempotency` | prior live (4×) | **PASS** | — |
| 10 | LLM extraction (structured) | `litellm-gateway.ts` `response_format: json_schema strict`, temp 0 | `extraction` | prior live D22/D23 | **PASS** | — |
| 11 | Schema validation before persist | `validateExtraction` (Zod) + catalog-code guard (I3) | `extraction`, `guards` | — | **PASS** | — |
| 12 | Catalog-only pricing (never model) | prices in `src/modules/orders` + `catalog`; model proposes codes only | `orders`, prompt-injection m-1024 | — | **PASS** | — |
| 13 | Deterministic decision | `src/modules/pipeline/decide.ts` | `decide`, `servicing-classification`, `cancellation` | — | **PASS** | — |
| 14 | Work-order read API / staff views | `/v1` orders + `portal-routes.ts` staff pages (state + last_error + needs-attention) | `orders`, `portal` | — | **PASS** | no retry-count / budget-remaining field |
| 15 | Cross-tenant isolation (forced RLS) | `app_user` NOBYPASSRLS, per-table policies, readiness policy-check | `portal`, `bootstrap-recovery`, `readiness` | — | **PASS** | Better-Auth tables global by design (documented) |
| 16 | LLM outage / timeout | per-call `AbortSignal.timeout` (20s); bounded pg-boss retry+backoff→DLQ→needs_review; circuit breaker + bulkhead | `resilient-gateway`, `pipeline` | — | **PASS** | DLQ collapses cause to one `last_error` |
| 17 | 429 / 500 / invalid-JSON handling | **D25:** `429` w/o budget marker → `RateLimitError` (retried); budget body → `held_budget`; 5xx/non-JSON → transient retry; schema-invalid → `invalid_output` | `gateway-error-classify` (4) | — | **PASS** | staff granularity limited at DLQ |
| 18 | Budget exhaustion visible + recovers | fail-closed `held_budget` (no spend); **D25** `recoverHeldBudget` re-drives via outbox when cap clears (not paused) | `budget`, `budget-authority`, `held-budget-recovery` (4) | — | **PASS** | soft cap (see 19) |
| 19 | Budget attribution + honest guarantee | per-shop LiteLLM team + virtual key; **soft cap** disclosed in staff UI | `budget-authority` | — | **PARTIAL** (by design) | bounded concurrency overshoot (hard cap is legacy path) |
| 20 | Customer-visible status | signed status token → `/f/status/:token` (raw state) | `web` | — | **PASS** | raw state string; web-sourced only |
| 21 | Worker runs on Cloud Run | **DEPLOYED + VERIFIED on staging 2026-11-06:** worker (+litellm sidecar) healthy on Cloud Run, processed real jobs, restart-durable; D25 health listener on `$PORT` | `worker-health` (3) + live staging | **live staging** | **PASS** | D27 fixed worker-env crash bugs (see report §7) |
| 22 | 40-message evaluation (deterministic) | `make eval` → `docs/results.md`; totals reconcile to 40 (32 orders/4 follow-ups/0 fail/1 ans/2 review/1 dup) | eval harness | — | **PASS** | drives services in-process (not pg-boss hop) |
| 23 | **40-message LIVE-model run + measured spend** | **EXECUTED 2026-11-06 on `openai/gpt-5.4-mini-2026-03-17` (D26):** 38 real calls, 33 ordered/3 follow-ups/2 review/1 answered/1 dup/**0 fail**, 28 363 tok, **$0.0307**, per-tenant cost reconciled exactly to LiteLLM team logs; cumulative $0.036 < $20. gpt-4o-mini run preserved as historical | `results-live-gpt-5.4-mini.md`, `MODEL_COST_REPORT.md` | **live, measured** | **PASS** | model varies ask-vs-extract on ambiguous msgs (documented); deterministic run authoritative for regression |
| 24 | ≤2-page architecture note | `docs/architecture.md` — Mermaid of actual components, boundaries, data model, RLS, 3 decisions | — | — | **PASS** | 86 lines / ~847 words (within 2 pages) |
| 25 | GCP IaC + written plan | `infra/terraform/` (`fmt`+`validate` ✅) + **live staging deploy verified** (`riverbend-staging`, 2026-11-06): real customer→work-order, RLS, budget hold+recovery, auth, durability (7/9) | terraform CI + `GCP_STAGING_DEPLOYMENT_REPORT.md` | **staging deployed + E2E** | **PASS** (staging) | prod LB+domain+HA shape Terraform-validated, not applied |
| 26 | Not-built + 100-shop scaling | `docs/not-built.md` (cut / next / breaks-first, evidence-ranked) | — | — | **PASS** | scaling = hypotheses (stated) |
| 27 | Real Resend two-way delivery | code + Svix verify + Receiving fetch + poll; fixtures in tests | `resend-webhook`, `email-poll` | prior live D21.2 send | **PARTIAL** | full two-way needs verified sending domain |
| 28 | README + links | reviewer "start here", one command, env, tests, eval, new-email setup, all doc links | — | — | **PASS** | — |
| 29 | Secret hygiene | `.env` git-ignored+untracked; history scan clean; gitleaks in CI | secret-scan CI | — | **PASS** | — |
| 30 | `npm ci` reliability | lockfile present; CI installs | CI | — | **PARTIAL** | CI keeps `npm ci || npm install` fallback (flagged in not-built) |

## Changes this pass (2026-11-06, D25) — exact files

**New/edited code:** `src/migrations/13000_shop_inbound_routing.cjs` (new), `src/modules/shops/index.ts`
(`setInboundAddress`/`resolveByInboundAddress`), `src/modules/email/index.ts` (new-inbound branch +
`normalizeBody`/`htmlToText`), `src/worker/health-server.ts` (new), `src/worker/index.ts` (intake+router
wiring, health server, held-budget recovery), `src/worker/sweeper.ts` (`recoverHeldBudget`),
`src/platform/llm/index.ts` (`RateLimitError`), `src/platform/llm/litellm-gateway.ts` (429≠budget),
`src/platform/config/index.ts` (`HELD_BUDGET_RETRY_SECONDS`), `scripts/provision.ts` (inbound addresses),
`infra/terraform/runtime.tf` (worker port + probes).

**New tests (+24 → 220):** `tests/integration/email-new-inbound.test.ts` (9),
`tests/integration/held-budget-recovery.test.ts` (4), `tests/unit/email-normalize.test.ts` (4),
`tests/unit/worker-health.test.ts` (3), `tests/unit/gateway-error-classify.test.ts` (4).

## Submission blockers (honest)

- ~~**P1 — live 40-message paid evaluation (#23):**~~ **RESOLVED 2026-11-06** — executed on
  **`openai/gpt-5.4-mini-2026-03-17`** (D26 upgrade) and on gpt-4o-mini (historical); measured spend $0.0307 /
  $0.0052, cumulative $0.036 (well under $20), 40/40 reconcile, per-tenant reconciled to LiteLLM logs. See
  `docs/MODEL_COST_REPORT.md`, `docs/results-live-gpt-5.4-mini.md`, `docs/TEST_RESULTS.md`.
- **P2 — live GCP apply (#25)** and **verified Resend sending domain (#27):** external access/authorization;
  IaC validates and code is tested, but neither was executed live.
- **P2 — fine-grained failure visibility (#16/17)** and **soft-cap overshoot (#19):** documented limitations,
  not defects.
