
## Phase — Classification taxonomy (D22)
- [x] T-cls1 Extraction system prompt: routine→TUNE_BASIC, overhaul→TUNE_FULL, diagnostic→GENERAL_INSPECT,
      specific→its code, price→price_inquiry, cancel→no order; a clear routine request is not clarified.
- [x] T-cls2 FakeGateway mirrors the taxonomy deterministically (service/maintenance/overhaul/inspect/cancel).
- [x] T-cls3 tests/unit/servicing-classification.test.ts (11 deterministic cases) + 1 live OpenAI call.

## Phase — Cancellation intent (D23)
- [x] T-cxl1 schema `REQUEST_KINDS` single source of truth; add `cancellation`; LiteLLM json_schema enum unified.
- [x] T-cxl2 decide(): `cancellation` → needs_review/`cancellation_requires_verification` (no order/clarification).
- [x] T-cxl3 prompt + FakeGateway classify cancel/reschedule → `cancellation`.
- [x] T-cxl4 tests/integration/cancellation.test.ts (8: m-1038, no-longer-needed, policy-question=price,
      unrelated-order-not-cancelled, mixed, duplicate idempotent, cross-tenant, prompt-injection).
- [x] T-cxl5 live m-1038 → needs_review, 0 orders/clarifications/emails (post-fix result in results-live.md).
