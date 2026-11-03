# Implementation Progress — Riverbend

Actual, evidence-backed status. "Done" means code + passing tests (and, where noted, a live run).
Updated as slices progress.

## Summary

| Slice | Spec | Plan | Tasks | Implemented | Tests | Converged | Committed |
|-------|------|------|-------|-------------|-------|-----------|-----------|
| 001-foundation | ✅ | ✅ | 61/61 | ✅ | ✅ 27 | ✅ | ✅ `b6dd646` |
| 002-intake-queue | ✅ | ✅ | 36/36 | ✅ | ✅ 13 | ✅ | ⏳ committing |
| 003-ai-pipeline | — | — | — | — | — | — | — |
| 004-orders-staff | — | — | — | — | — | — | — |
| 005-web-form | — | — | — | — | — | — | — |
| 006-email | — | — | — | — | — | — | — |
| 007-resilience | — | — | — | — | — | — | — |
| 008-eval-and-deploy | — | — | — | — | — | — | — |

## Test commands & last result

- `npm run typecheck` → clean
- `npm run lint` (dependency-cruiser) → 0 violations
- `npm test` (Vitest + Testcontainers, real PostgreSQL; Docker required) → **40 passed / 40**
- Live: `make up` → api + worker + db ready; intake smoke verified through real pg-boss.

## Blockers

- **B1** real LLM credentials (blocks 003 real-provider run + 008 live 40-sample eval/cost).
- **B2** GCP account (blocks 008 live deploy; IaC + `terraform validate` still produced).

See [AUTONOMOUS_DECISIONS.md](./AUTONOMOUS_DECISIONS.md) for rationale.

## Current feature

Starting **003-ai-pipeline** — buildable against a fake model server; real-provider verification gated on B1.
