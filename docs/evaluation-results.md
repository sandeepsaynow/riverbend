# Riverbend — Evaluation Results (40 sample messages)

Reproducible with one command. Two modes; **deterministic is authoritative for this submission**, the
real-model path is documented and partially measured (see §Real-model).

- `make eval`        → deterministic (recorded golden extraction → real code pipeline; free) → writes `docs/results.md`
- `make eval-live`   → real OpenAI via the LiteLLM proxy (paid; measures tokens + LiteLLM-calculated cost)

**Execution fidelity (honest scope).** The harness exercises the real `intake → (gateway) → validate →
decide → catalog-price → order` services and real Postgres, but drives the pipeline **in-process** — it does
not replay the `pg-boss` queue/worker hop (that path has its own integration tests). Email-channel samples
are injected as intake, not delivered through a real inbox; the new inbound-email path (D25) is covered by
`tests/integration/email-new-inbound.test.ts`, not by a live Resend delivery here. No claim of live inbox
delivery or live-model results is made from this deterministic run.

## Run metadata (deterministic)

| Field | Value |
|---|---|
| Evaluation date | 2026-11-04 |
| Dataset | `eval/messages.json` — the brief's 40 sample messages (3 shops, email+web), incl. the 8 tricky cases |
| Model / provider | **none** (deterministic) — golden expected extraction feeds the real validate→price→decide pipeline |
| Execution mode | `recorded` (deterministic) |
| Messages processed | 40 |
| Work orders created | **32** |
| Follow-ups requested | **4** |
| Failures (model/API) | **0** |
| Other valid business outcomes | answered (price): 1 · needs_review: 2 · duplicate (idempotent replay): 1 |
| Total model calls | 0 (no live calls) |
| Input / output tokens | 0 / 0 (deterministic) |
| Total model cost | **$0.00 real** — reserve *estimate* only: 74 000 micros ≈ **$0.0740** (NOT real spend) |
| Avg cost / message | n/a (deterministic) |
| Total work-order value | **$1 865.00** (catalog-priced in code) |
| Run duration | ~a few seconds (all ≤30 ms/message after DB warm-up) |

### Counting rules (explicit)
- **Work order created** = request outcome `ordered` (a priced `work_orders` row exists). → 32
- **Follow-up requested** = outcome `awaiting_customer` (exactly one clarification, I6). → 4
- **Failure** = a model/API error or invalid-output rejection only. Valid *business* outcomes are **not**
  failures: `answered` (price inquiry, 1), `needs_review` (wrong-shop + cancellation, 2), `duplicate`
  (idempotent replay, 1). → failures = 0.
- 32 + 4 + 1 + 2 + 1 = **40** ✓ (consistent with the per-message rows).

## Summary table

| Total messages | Work orders created | Follow-ups | Failures | Total model spend |
|---:|---:|---:|---:|---:|
| 40 | 32 | 4 | 0 | $0.00 real (est. $0.074; deterministic) |

## Per-message results (deterministic)

Expected outcome in `recorded` mode = the golden-defined outcome; **actual matched expected for all 40**
(deterministic). Model cost is the per-call reserve estimate (2 000 micros) where the pipeline would call
the model; `—` where no call happens (short-circuited business outcomes). Full table also in `docs/results.md`.

| Message | Expected = Actual | WO created | Follow-up | Failure | Model cost (est.) |
|---|---|:--:|:--:|---|--:|
| m-1001 | ordered TUNE_BASIC×1 ($65) | ✓ | | | 2000µ |
| m-1002 | ordered FLAT_FIX×1 ($15) | ✓ | | | 2000µ |
| m-1003 | ordered GEAR_ADJUST×1 ($25) | ✓ | | | 2000µ |
| m-1004 | ordered BRAKE_PADS×1 ($35) | ✓ | | | 2000µ |
| m-1005 | ordered BRAKE_ADJUST+GEAR_ADJUST ($43) | ✓ | | | 2000µ |
| m-1006 | ordered WHEEL_TRUE×1 ($30) | ✓ | | | 2000µ |
| m-1007 | ordered TUNE_FULL×1 ($185) | ✓ | | | 2000µ |
| m-1008 | ordered EBIKE_DIAG×1 ($60) | ✓ | | | 2000µ |
| m-1009 | needs_review (wrong shop) | | | not a failure (business) | — |
| m-1010 | ordered CHAIN_REPLACE×1 ($45) | ✓ | | | 2000µ |
| m-1011 | ordered BRAKE_BLEED×1 ($40) | ✓ | | | 2000µ |
| m-1012 | ordered GENERAL_INSPECT×1 ($25) | ✓ | | | 2000µ |
| m-1013 | awaiting_customer (ambiguous) | | ✓ | | 2000µ |
| m-1003 (resend) | duplicate (idempotent replay) | | | not a failure | — |
| m-1015 | ordered TUNE_BASIC×1 ($65) | ✓ | | | 2000µ |
| m-1016 | ordered GEAR_ADJUST×1 ($25) | ✓ | | | 2000µ |
| m-1017 | ordered BRAKE_ADJUST×2 ($36) | ✓ | | | 2000µ |
| m-1018 | answered (price inquiry) | | | not a failure (business) | 2000µ |
| m-1019 | ordered WHEEL_TRUE×1 ($30) | ✓ | | | 2000µ |
| m-1020 | awaiting_customer (ambiguous) | | ✓ | | 2000µ |
| m-1021 | awaiting_customer (ambiguous) | | ✓ | | 2000µ |
| m-1022 | ordered EBIKE_DIAG×1 ($60) | ✓ | | | 2000µ |
| m-1023 | ordered TUNE_BASIC+WHEEL_TRUE ($95) | ✓ | | | 2000µ |
| m-1024 | ordered CHAIN_REPLACE×1 ($45) — prompt-injection ignored | ✓ | | | 2000µ |
| m-1025 | ordered GENERAL_INSPECT×1 ($25) — "whatever it needs" | ✓ | | | 2000µ |
| m-1026 | ordered GEAR_ADJUST×1 ($25) | ✓ | | | 2000µ |
| m-1027 | awaiting_customer (ambiguous) | | ✓ | | 2000µ |
| m-1028 | ordered GEAR_ADJUST×1 ($25) | ✓ | | | 2000µ |
| m-1029 | ordered BRAKE_BLEED×2+BRAKE_PADS×2 ($150) | ✓ | | | 2000µ |
| m-1030 | ordered FLAT_FIX×1 ($15) | ✓ | | | 2000µ |
| m-1031 | ordered WHEEL_TRUE×2 ($60) | ✓ | | | 2000µ |
| m-1032 | ordered TUNE_BASIC×1 ($65) — single bike | ✓ | | | 2000µ |
| m-1033 | ordered BRAKE_ADJUST×2+GEAR_ADJUST ($61) — Spanish | ✓ | | | 2000µ |
| m-1034 | ordered CHAIN_REPLACE×1 ($45) | ✓ | | | 2000µ |
| m-1035 | ordered TIRE_REPLACE×2 ($40) | ✓ | | | 2000µ |
| m-1036 | ordered EBIKE_DIAG×1 ($60) | ✓ | | | 2000µ |
| m-1037 | ordered BRAKE_BLEED×1 ($40) | ✓ | | | 2000µ |
| m-1038 | needs_review (cancellation → staff, D23) | | | not a failure (business) | — |
| m-1039 | ordered FLAT_FIX+TUNE_FULL ($200) | ✓ | | | 2000µ |
| m-1040 | ordered TUNE_BASIC×2 ($130) — two bikes | ✓ | | | 2000µ |

(Tricky-case notes — prompt injection, idempotent resend, wrong-shop, price inquiry, delegation,
cancellation, Spanish, ambiguous — are in `docs/results.md §Tricky cases`.)

## Real-model (OpenAI via LiteLLM)

- **Not re-run as a bulk paid job for this submission** (bulk paid evaluation requires explicit approval).
  Run it when authorized: `docker compose --profile llm up -d litellm && make eval-live` (keep aggregate
  spend < the configured cap). It writes real tokens + the LiteLLM-calculated `x-litellm-response-cost`.
- **Measured real-model evidence that exists:** `docs/results-live.md` (a prior authorized 40-message live
  run + the dated post-fix single-message re-run for **m-1038** under D23) and `docs/results-live-before-guards.md`
  (the earlier pre-guard live run, preserved as history). Single controlled live calls were also used to
  verify **D22** ("general servicing" → TUNE_BASIC, ordered) and **D23** (m-1038 → needs_review), each ~500–700
  tokens. These are real provider calls; the deterministic estimate above is **not** labelled as real spend.
- If no real key is configured, `make eval` (deterministic) is the authoritative run and real-model spend is
  **NOT MEASURED** — never synthesize it.
