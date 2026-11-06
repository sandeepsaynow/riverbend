# Riverbend — Submission Checklist

Verified 2026-11-06. Status: **PASS** (verified) · **PARTIAL** · **BLOCKED** (needs external access) · **FAIL**.
Commands run from `app/`. Docker required for tests/eval (real PostgreSQL via Testcontainers).
Full requirement-by-requirement matrix: **`docs/FINAL_SUBMISSION_ACCEPTANCE.md`**. 2026-11-06 added new
inbound-email intake (D25), a Cloud Run worker health listener, `429`≠budget, `held_budget` auto-recovery, and
the **production model upgrade to `openai/gpt-5.4-mini-2026-03-17` (D26)** with a measured live run + per-tenant
cost accounting (`docs/MODEL_COST_REPORT.md`, `docs/TEST_RESULTS.md`) → **222 passing**.

## Mandatory requirements

| # | Requirement | Status | Evidence | Remaining limitations |
|--:|---|---|---|---|
| 1 | Git repo with code + meaningful tests | **PASS** | 52+ commits on `main`, pushed to `github.com/sandeepsaynow/riverbend`; `npx vitest run` → **222 passed** (35 files, real PostgreSQL) | — |
| 2 | One-command local startup | **PASS** | `docker compose up --build` (or `make up`); `docker compose config -q` + local overlay both valid; stack boots healthy (`/readyz`→ready, api+worker+db) verified in earlier live runs | host `:5432` conflict → use the local overlay (documented) |
| 3 | Working demonstration | **PASS** | Live: customer form → catalog-priced work order; admin/staff login; cross-shop isolation; real-OpenAI order ($110 / $65). Deterministic by default (FakeGateway) | in-browser click-through (T054) is a manual step; guide in `FINAL_MANUAL_TEST.md` |
| 4 | Reproducible 40-message evaluation | **PASS** | Both modes run: `make eval` (deterministic) → `docs/results.md`; **`make eval-live` EXECUTED 2026-11-06** on **`openai/gpt-5.4-mini-2026-03-17`** (D26) → `docs/results-live-gpt-5.4-mini.md` (38 real OpenAI calls); gpt-4o-mini run preserved as historical | — |
| 5 | Results table (orders / follow-ups / failures / spend) | **PASS** | **Live gpt-5.4-mini (measured):** 40 → **33 orders, 3 follow-ups, 0 failures**, 1 answered, 2 needs-review, 1 duplicate; $1,841 value; **real spend $0.0307**, per-tenant reconciled to LiteLLM team logs, 28,363 tokens. gpt-4o-mini historical: 36/0/0, $0.0052. Deterministic: 32/4/0, $1,865. See `docs/MODEL_COST_REPORT.md` | live model varies ask-vs-extract on ambiguous msgs (documented); deterministic authoritative for regression |
| 6 | ≤ 2-page architecture note | **PASS** | `docs/architecture.md` — Mermaid of **actual** components (no Next.js/Redis), module boundaries, data model, tenant isolation, 3 decisions to challenge | — |
| 7 | "Not Built" document | **PASS** | `docs/not-built.md` — deliberately-omitted · build-next · top-3 breaks-at-100-shops (evidence-based) | scaling limits are hypotheses for load testing (stated) |
| 8 | Realistic GCP deployment + IaC | **PASS** (IaC validated) + **DEPLOYED & E2E-VERIFIED on staging** | `infra/terraform/` (`fmt`+`validate` ✅); **live staging deploy 2026-11-06** (`riverbend-staging`): Cloud Run api/worker(+litellm sidecar)/Cloud SQL — customer→work-order via real gpt-5.4-mini ($65), RLS isolation, idempotency, auth, budget hold+recovery, restart durability (7/9 PASS). See `docs/GCP_STAGING_DEPLOYMENT_REPORT.md` | prod LB+domain+HA shape validated, not applied; live email + LLM-outage not verified |
| 9 | Clear, accurate README | **PASS** | `README.md` — reviewer "start here" + one command at top, env, tests, eval summary, links to all submission docs; stack stated accurately | — |

## Engineering verification (this run)

| Check | Status | Command / evidence |
|---|---|---|
| Strict typecheck | **PASS** | `npm run typecheck` (clean) |
| Module boundaries (lint) | **PASS** | `npm run lint` → dependency-cruiser, 0 violations (93 modules) |
| Unit + integration tests | **PASS** | `npx vitest run` → **222 passed / 222** (35 files, real PostgreSQL) |
| Docker Compose config | **PASS** | `docker compose config -q` + `-f … -f docker-compose.local.yml --profile llm config -q` |
| Terraform | **PASS** | `terraform fmt -check -recursive` + `terraform validate` → Success |
| Secret scan (tracked + history) | **PASS** | `git grep` secret patterns across all history → no matches; only `.env.example` (placeholders); `.env` git-ignored & never committed; CI runs gitleaks |
| CI | **PASS** | `.github/workflows/ci.yml` — typecheck, lint, tests, gitleaks, terraform, compose-config; manual OIDC deploy in `deploy.yml` (workflow_dispatch + environment approval) |

## Test coverage map (mandatory areas → tests)

Request validation/normalization, LLM-output validation, catalogue pricing/estimates, classification,
follow-up decision, cancellation (D23), budget-exceeded, retry/DLQ, idempotency, tenant context — covered by
`tests/unit/{extraction,decide,servicing-classification,config,guards,catalog-loader,reply-token}.test.ts`
and `tests/integration/{pipeline,orders,budget,cancellation,web,web-idempotency,email,resend-webhook,email-poll,portal,bootstrap-recovery,csrf-origin,better-auth,staff-identity,readiness}.test.ts`.
Auth/authorization + cross-shop RLS + concurrent-duplicate constraints are exercised on real PostgreSQL
(e.g. `portal`, `bootstrap-recovery`, `web-idempotency`, `cancellation`). External email/LLM are faked;
Postgres is real.

## Files changed in this submission-readiness pass
- **Added:** `docs/architecture.md`, `docs/not-built.md`, `docs/evaluation-results.md`,
  `docs/gcp-deployment.md`, `docs/submission-checklist.md`, `.github/workflows/deploy.yml`.
- **Edited:** `.github/workflows/ci.yml` (+compose-config job), `README.md` (reviewer section), `docs/results.md`
  (regenerated by `make eval`).
- **No code/schema/architecture changes** — functionality preserved; no files deleted; `.gitignore` already
  excludes `.env`/`.env.*`/`node_modules`/`dist`/`*.log`.

## Remaining blockers (all external / out-of-scope, documented)
- **Real-model full-40 eval** — **DONE 2026-11-06** on `openai/gpt-5.4-mini-2026-03-17` (D26), $0.0307 measured, per-tenant reconciled. **Live GCP apply** still needs a GCP project/authorization (gated; not run).
- **Resend** real two-way delivery needs a verified sending domain (`docs/FINAL_MANUAL_TEST.md`).
- **In-browser T054** smoke is a manual step (automated + live-API cover the invariants).
- **Prod hardening** noted in `not-built.md` (restricted DB role for Better Auth, worker autoscaling, OTel).
