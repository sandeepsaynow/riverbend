# Feature 007 — Resilience (lean spec)

**Input**: D13/D15/D16 + Constitution VI ("Failure Is Normal"). Contain model-call failures so a bad
provider day never loses an accepted request or overspends, and give operators a kill switch. pg-boss
remains the **sole retry authority** (002/003); this slice adds failure *containment* around the call.

## Built this slice (verified)
- **Per-call timeout** on the real gateway (`LLM_TIMEOUT_MS`, 006/003) — bounded wait, message-only errors.
- **Circuit breaker** around the model call: opens after `AI_CIRCUIT_FAILURE_THRESHOLD` consecutive
  failures for `AI_CIRCUIT_COOLDOWN_MS`, then a half-open trial; success closes it. Protects the provider
  from a thundering retry herd. Open → `CircuitOpenError` (transient; pg-boss retries → DLQ → needs_review).
- **Per-shop bulkhead**: at most `AI_MAX_CONCURRENCY_PER_SHOP` in-flight model calls per shop — one noisy
  shop cannot starve the others. Full → `BulkheadFullError` (transient).
- **Global "AI paused" switch** (`AI_PAUSED`): requests park `held_budget` (honest no-AI hold; staff see
  it) with **no** model call and **no** charge; resumes when the switch clears.
- All of the above compose in a `ResilientGateway` decorator over any `LlmGateway` (Principle IV), wired
  in the worker. The deterministic FakeGateway and the 002-cap behaviour already cover outage/cap demos.
- **Privacy (VII) already holds**: ids-only logging — no message text, prompts, answers, or emails in
  logs or errors; verified across 003–006.

## Functional requirements
- **FR-001**: A model-call failure MUST be contained by the breaker; the breaker MUST NOT itself retry
  (pg-boss owns retries). **FR-002**: One shop's load MUST NOT exhaust another's (bulkhead, I1-adjacent).
- **FR-003**: When paused, no provider call is made and the request parks a recoverable `held_budget`.
- **FR-004**: Transient containment errors (timeout/open/bulkhead) MUST surface as retryable; exhaustion
  routes to `needs_review` (VI). Budget-rejection / paused route to `held_budget` (no charge).

## Designed, NOT built this slice (honest scope, IX)
- **OpenTelemetry tracing / Phoenix** and the alert set — the hooks are designed (ids-only spans) but not
  wired; metrics are left to 008/deploy. **Retention/TTL job** for stored prompts/answers — configurable
  bound specified (VII) but the sweeper is not implemented. Both are on the not-built list (README/008).

## Acceptance (zero external deps)
- Paused → `AiPausedError`, delegate not called; pipeline → `held_budget`, no charge.
- Breaker opens after N failures (fast-fail `CircuitOpenError`), half-opens after cooldown, resets on
  success. Bulkhead rejects an over-limit concurrent call for the same shop; a different shop is
  unaffected. `lastCostMicros` passes through the wrapper.
