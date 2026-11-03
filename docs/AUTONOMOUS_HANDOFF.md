# Autonomous Handoff — Riverbend

**Execution stopped at a single-session size limit, not a blocker.** Slices 001–004 are implemented,
tested, and committed (verified). 005–008 are not started. Nothing below is fabricated; "pending"
means not built.

## Current state (verified)

| Slice | Status | Commit |
|---|---|---|
| 001 foundation | ✅ complete, converged | `b6dd646` |
| 002 intake-queue | ✅ complete, converged | `4df4cfd` |
| 003 ai-pipeline | ✅ complete vs **FakeGateway** (real provider pending B1) | `b377d86` |
| 004 orders-staff | ✅ complete (cancel + staff-HTML deferred) | `64233a9` |
| 005–008 | ⛔ pending | — |

Branch: `004-orders-staff` (each slice branched off the prior). Tests: `npm test` → **69/69** on real
PostgreSQL (Docker). `npm run typecheck` + `npm run lint` clean. Live flow verified via `make up`:
message → `202` → dedupe/409 → worker (intake → ai-pipeline → orders) → `ordered`; `GET /v1/orders`
returns the code-priced order.

## How to resume (exact commands)

```sh
# verify current state
docker info >/dev/null 2>&1 || open -a Docker        # Docker must be running for tests
npm install
npm run typecheck && npm run lint && npm test         # expect 69 passed
ADMIN_BOOTSTRAP_TOKEN=local-dev-admin-secret make up  # api + worker + pg-boss + Postgres
make down
```

Each new slice: `git checkout -b 00X-name` off the previous branch; write `specs/00X-name/spec.md`
(+ lean plan) grounded in `docs/ARCHITECTURE_DECISIONS.md` + `docs/EDGE_CASES.md`; implement in
`src/modules/<name>` reusing the platform; add real-PostgreSQL tests under `tests/`; keep
typecheck/lint/tests green; commit; update `docs/IMPLEMENTATION_PROGRESS.md` + `AUTONOMOUS_DECISIONS.md`.

## Next actions, in priority order

### 005 — web form (D11)  [no external deps]
- Hosted per-shop form reusing the 002 intake path. Public submission endpoint (shop selected by a
  public shop key / slug, not a secret), **mandatory email field**, browser-generated UUID as the
  `submission_id` so a refresh/retry is idempotent (reuse 002's `(shop, source='web', submission_id)`).
- Server-side defences: origin allowlist + CORS, per-IP/per-shop rate limits (reuse express-rate-limit),
  honeypot, size limits, strict validation, output encoding/CSP. Bot-check (Turnstile) is server-side
  verified — stub the verifier behind an interface (no key needed; a fake passes in tests), real key gated.
- Status page + magic-link read (reuse `GET /v1/requests/:id` via a signed status token).
- Tests: double-submit → one request; honeypot/oversize/bad-origin rejected; missing email → 422.

### 006 — email (D10)  [local: Mailpit; no production creds]
- `EmailTransport` port + Mailpit adapter (docker-compose service `mailpit`). Outbox table for outbound
  (reuse the transactional-outbox pattern) → send the one follow-up question (from 003 `follow_ups`).
- Inbound: a signed webhook adapter; match replies by a signed `reply+<token>@` address +
  `In-Reply-To`/`References`; strip quoted text; de-dup by `Message-ID`. On reply → call
  `PipelineService.applyReply` + enqueue a pipeline job with `isReply` (003 already supports this).
- Failed send → needs_review ("delivery failed"); order never rolled back.
- Tests: m-1027 reply resumes by email (Mailpit); failed send parks needs_review.

### 007 — resilience (D13/D15/D16)  [no external deps]
- Timeouts + circuit breaker + per-shop bulkhead around `LlmGateway`; the "AI paused" switch; the
  outage demo (fake gateway returns 503 → retry/park/drain) and the cap demo (tiny cap → held_budget).
- OpenTelemetry (Phoenix local) tracing; the eight alerts; retention job; PII redaction in traces.
- Note: pg-boss already owns retries (003); add the breaker/bulkhead/timeout around the model call only.
- Tests: timeouts/503 retry then park; crash after AI call → no second charge (receipt reuse already works).

### 008 — eval + deploy (D18 / Part 7)  [eval real-run gated on B1; GCP gated on B2]
- Evaluation runner: replay the brief's 40 sample deliveries through the HTTP API, answer follow-ups
  like a customer, write `docs/results.md` (outcome, services, total, AI cost micros, latency per msg),
  score vs a golden set. `make eval` uses recorded/fake answers (free, deterministic, CI). `make eval-live`
  uses the real provider (**B1**, costs money, ledger-tracked, < USD 20) — leave clearly pending.
- Terraform (Cloud Run api + worker pool, Cloud SQL, Vertex AI, Secret Manager, Artifact Registry, LB +
  Cloud Armor, internal LiteLLM) + GitHub Actions via Workload Identity Federation; CI runs
  `terraform validate` + `plan` — **no live deploy (B2)**.
- README: honest hours, not-built list, "what breaks first at 100 shops"; 2-page architecture note.

## Blockers (external; do not fake)
- **B1** real LLM credentials → 003 real-provider run + the live 40-sample eval + real cost report.
- **B2** GCP account → live deploy (IaC + `terraform validate` still produced in 008).

## Guardrails to preserve (all currently honored)
No cross-tenant access (forced RLS, every table); no content/email/session-based dedup (submission-id
only); no duplicate work orders (unique (shop,request,bike) = I2); no invented prices (code + catalog
snapshot = I5); no unvalidated LLM output persisted (I3); one clarification (UNIQUE follow_up = I6);
pg-boss the sole retry authority; spend in micros under a per-shop cap (I4); no secrets in Git;
ids-only logging (no customer text).
