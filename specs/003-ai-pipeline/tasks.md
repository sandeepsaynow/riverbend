
## Phase — Classification taxonomy (D22)
- [x] T-cls1 Extraction system prompt: routine→TUNE_BASIC, overhaul→TUNE_FULL, diagnostic→GENERAL_INSPECT,
      specific→its code, price→price_inquiry, cancel→no order; a clear routine request is not clarified.
- [x] T-cls2 FakeGateway mirrors the taxonomy deterministically (service/maintenance/overhaul/inspect/cancel).
- [x] T-cls3 tests/unit/servicing-classification.test.ts (11 deterministic cases) + 1 live OpenAI call.
