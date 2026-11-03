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

003-ai-pipeline checkpoint 1 committed. Next: 003 decision/one-question/worker wiring, then 004.
