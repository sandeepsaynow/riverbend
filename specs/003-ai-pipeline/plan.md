# Implementation Plan: AI Extraction Pipeline (003)

**Branch**: `003-ai-pipeline` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

## Summary
The worker's `awaiting_pipeline` step now runs: budget **reserve** → `LlmGateway.extract` (fake in
tests; LiteLLM/Vertex in prod, D6) → **schema validation** (I3) → budget **settle** → deterministic
**decision** (I6 one question; wrong-shop/price-inquiry/delegation paths) → set state. pg-boss stays
the single retry authority (002). Code owns every decision and side effect; the model only fills a
strict form and may draft a question's wording. No pricing totals / work orders (004), no email (006).

## Technical Context
TypeScript/Node + Express + pg (001/002). New: `LlmGateway` port (`platform/llm`) with `FakeGateway`
(deterministic, keyword-driven) and a `LiteLlmGateway` stub (throws unless `LLM_*` configured — gated
on B1). Zod extraction schema. New tables `shop_budgets`, `llm_calls`, `extractions`, `follow_ups`
(all shop-owned, forced RLS). Money/spend in integer **micros** (millionths USD). Testing: Vitest +
Testcontainers real PostgreSQL + the fake gateway (no network, no key).

## Constitution Check (gated principles)
- **I (code owns decisions)** — model only fills the strict form + drafts question wording; code decides, reserves/settles, sets state. ✅
- **II/III/VII/VIII** — invariants I3 (validation), I4 (budget), I6 (one question) each get a test; new tables carry `shop_id` + forced RLS (III); no message text/PII logged (VII); tests on real PostgreSQL + fake AI server (VIII — the constitution's explicit allowance; real-provider run gated on B1). ✅
- **V** — LiteLLM/model behind `LlmGateway` (two-way); budget ledger + millionths money (one-way, recorded). ✅
- **Gate: PASS.** Deviation logged: `extracted` success state bridges to slice 004 (order creation), since pricing/orders are 004.

## Structure (additions)
```
src/platform/llm/
  index.ts            # LlmGateway port + ExtractionInput/Result types
  fake-gateway.ts     # deterministic fake (tests + local demo)
  litellm-gateway.ts  # real adapter stub (D6); throws unless configured (B1)
src/modules/pipeline/
  index.ts            # PipelineService.run(requestId): reserve→extract→validate→settle→decide→state
  schema.ts           # Zod strict extraction form + validation (I3)
  decide.ts           # deterministic decision (I6, wrong-shop/price/delegation)
src/modules/budget/
  index.ts            # BudgetService: reserveMicros (atomic), settle, receipt (replay-safe), reap
src/migrations/4000_pipeline.cjs   # shop_budgets, llm_calls, extractions, follow_ups + RLS + CHECK(≤1)
```
Worker `processor.ts` calls `PipelineService.run` instead of the 002 no-op. `LlmGateway` built in the
worker composition root (fake by default; LiteLLM when `LLM_*` set).

## Complexity Tracking
None — reuses 001/002 infra; no new services.
