# Riverbend — Test Results & Evidence

**Executed 2026-11-06.** All results below are from real runs in this environment (not asserted). The test
suite uses **real PostgreSQL via Testcontainers** for every integration test; external email/LLM are faked at
the port boundary (the DB is never faked).

## 1. Environment

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Git commit (at run) | `15788c0` → committed as the D26 upgrade commit (see §12) |
| Node | v24.2.0 |
| Test runner | Vitest 2.1.9 |
| DB | PostgreSQL 16 via Testcontainers (ephemeral, per-suite) |
| OS | macOS (darwin 24.6) |

## 2. Commands executed

```
npm run typecheck                     # tsc -p tsconfig.json --noEmit
npm run lint                          # dependency-cruiser (module boundaries)
npx vitest run                        # full unit + contract + integration suite (real Postgres)
docker compose config -q              # + local overlay with --profile llm
terraform -chdir=infra/terraform fmt -check -recursive && terraform validate
# live model eval (separate, paid): EVAL_LLM_BASE_URL=http://localhost:4000/v1 make eval-live
```

## 3. Aggregate result

| Check | Result | Evidence |
|---|---|---|
| Strict typecheck | **PASS** | `tsc --noEmit` clean |
| Module-boundary lint | **PASS** | dependency-cruiser: 0 violations (99 modules, 198 deps) |
| **Full test suite** | **PASS — 251 / 251** | 39 files (unit 72 / contract 1 / integration 178); duration ~46 s; **0 failed, 0 skipped** |
| Docker Compose config | **PASS** | default + `--profile llm` local overlay both valid |
| Terraform | **PASS** | `fmt -check` + `validate` → Success |
| Live model eval (gpt-5.4-mini) | **PASS** | 40 msgs, 38 real calls, 0 failures; `docs/results-live-gpt-5.4-mini.md` |

Discovered = executed = 251. Nothing was skipped or excluded.

## 4. By category (39 files, 251 tests) — unit 72 · contract 1 · integration 178

- **Unit (14 files):** `catalog-loader`, `config`, `decide`, `email-normalize`, `email-reply-safety`,
  `extraction`, `gateway-error-classify`, **`gateway-request` (D26)**, `guards`, `reply-token`,
  `resilient-gateway`, `servicing-classification`, **`shop-router-llm` (D34)**, `worker-health`.
- **Contract (1 file):** `route-schema`.
- **Integration — real Postgres (24 files):** `better-auth`, `bootstrap-recovery`, `budget-authority`,
  `budget`, `cancellation`, `credentials`, `csrf-origin`, `email-new-inbound`, `email-poll`, `email`,
  `foundation`, `guards-pipeline`, `held-budget-recovery`, `intake`, `orders`, `pipeline`, `portal`,
  **`provision-shops` (D31)**, `readiness`, `resend-webhook`, `staff-identity`, `web-idempotency`, `web`, **`email-llm-routing` (D34, LLM router wired into EmailService)**.

## 5. Coverage of the mandatory areas

| Area | Test(s) |
|---|---|
| LLM extraction / structured output | `tests/unit/extraction.test.ts`, `tests/integration/pipeline.test.ts` |
| **New-model param compatibility (D26)** | `tests/unit/gateway-request.test.ts` (asserts `max_completion_tokens`, not `max_tokens`; strict schema; captures backing-model header) |
| LLM failure classification (429/budget/5xx) | `tests/unit/gateway-error-classify.test.ts`, `tests/unit/resilient-gateway.test.ts` |
| Catalog pricing / quantities | `tests/integration/orders.test.ts`, `tests/unit/catalog-loader.test.ts` |
| Deterministic decision / classification | `tests/unit/decide.test.ts`, `tests/unit/servicing-classification.test.ts`, `tests/unit/guards.test.ts`, `tests/integration/guards-pipeline.test.ts` |
| Idempotency / duplicate protection | `tests/integration/intake.test.ts` (50-concurrent), `tests/integration/web-idempotency.test.ts` |
| Tenant RLS / cross-shop isolation | `tests/integration/portal.test.ts`, `tests/integration/foundation.test.ts`, `tests/integration/readiness.test.ts` |
| Per-shop budget + attribution / recovery | `tests/integration/budget.test.ts`, `tests/integration/budget-authority.test.ts`, `tests/integration/held-budget-recovery.test.ts` |
| Email intake (new + reply) / webhook / poll | `tests/integration/email-new-inbound.test.ts`, `email.test.ts`, `resend-webhook.test.ts`, `email-poll.test.ts`, `tests/unit/email-normalize.test.ts` |
| **LLM shop routing (D34)** — code-validated, regex fallback, budget fallback, injection rejection | `tests/unit/shop-router-llm.test.ts` (resolver) + `tests/integration/email-llm-routing.test.ts` (wired into EmailService, real PG, **mocked classifier**) + real-model eval 6/6 (`docs/results-live-gpt-5.4-mini.md`/§routing) |
| **Generic-email shop resolution & pending clarification → reply → order (D32)** | `tests/integration/email-new-inbound.test.ts` (per-shop mention, no-shop/ambiguous → pending, reply resolves → one order) |
| **Reply-safety / loop protection (D30)** | `tests/unit/email-reply-safety.test.ts` + the no-reply pending case in `email-new-inbound.test.ts` |
| Same-browser independent submissions | `tests/integration/web-idempotency.test.ts` |
| Auth / CSRF | `tests/integration/better-auth.test.ts`, `csrf-origin.test.ts`, `staff-identity.test.ts`, `bootstrap-recovery.test.ts` |
| Worker health (Cloud Run) | `tests/unit/worker-health.test.ts` |
| API credentials (`/v1`) | `tests/integration/credentials.test.ts` |

## 6. Failure-injection coverage

- Budget exhaustion → fail-closed `held_budget`, then automatic recovery: `held-budget-recovery.test.ts`,
  `budget-authority.test.ts`.
- Upstream 429 vs budget vs 5xx classification (retry-vs-hold): `gateway-error-classify.test.ts`.
- Circuit breaker + bulkhead + AI-paused: `resilient-gateway.test.ts`.
- DLQ / bounded retry → `needs_review` on exhaustion: `pipeline.test.ts`.

## 7. Model-compatibility results (D26, live)

- Direct provider probe: `gpt-5.4-mini-2026-03-17` **rejects** `max_tokens` (HTTP 400 → "use
  `max_completion_tokens`"); **accepts** `max_completion_tokens` + `temperature:0` + strict `json_schema`.
- Through the proxy: alias `riverbend-extraction` → `openai/gpt-5.4-mini-2026-03-17` (confirmed via
  `x-litellm-model-name`); `x-litellm-response-cost` present (attribution intact); `reasoning_tokens=0`.
- Regression guard added: `tests/unit/gateway-request.test.ts` pins the request shape.

## 8. Known skipped / unverified

- **In-browser click-through (T054):** manual; automated + live-API cover the invariants (`docs/FINAL_MANUAL_TEST.md`).
- **Live GCP apply / verified Resend sending domain:** need external authorization (gated; not run).
- No tests are `.skip`-ped in the suite.

## 9. Failures encountered & resolution

None in the test suite (246/246, clean first pass). During the D26 upgrade the **only** real incompatibility found was
the `max_tokens` → `max_completion_tokens` parameter change (caught by the pre-upgrade provider smoke test,
fixed in `src/platform/llm/litellm-gateway.ts`, pinned by `gateway-request.test.ts`).

## 10. Reproduction

```
docker compose --profile llm up -d db litellm      # Postgres + proxy (proxy holds OPENAI_API_KEY)
npm ci
npm run typecheck && npm run lint
npx vitest run                                      # 246 tests, real Postgres
EVAL_LLM_BASE_URL=http://localhost:4000/v1 make eval-live   # paid live eval (optional)
```

Related reports: [`MODEL_COST_REPORT.md`](MODEL_COST_REPORT.md) ·
[`evaluation-results.md`](evaluation-results.md) · [`results-live-gpt-5.4-mini.md`](results-live-gpt-5.4-mini.md) ·
[`results-live-gpt-4o-mini.md`](results-live-gpt-4o-mini.md).
