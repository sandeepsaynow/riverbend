# Riverbend — Architecture note (2 pages)

## Thesis
Turn messy inbound messages into schema-validated work orders where **the AI interprets and code
decides, prices, and owns every side effect.** The model is untrusted input that fills a strict form;
it never sets a price, state, or action. That single rule drives correctness, testability, and
prompt-injection resistance.

## Shape
A **modular monolith**, one codebase and image, run as **two processes**: `api` (HTTP) and `worker`
(queue consumer). Modules (`auth`, `shops`, `catalog`, `intake`, `pipeline`, `budget`, `orders`, `web`,
`email`) talk only through public entry files; a build-time check (dependency-cruiser) enforces the
boundaries, and the three reversible choices — **job queue, AI gateway, email** — sit behind our own
ports so they stay swappable. Framework code (Express) lives only in the composition layer.

```
customer ──(web form / email webhook / JSON API)──▶ api ──▶ intake.submit (atomic: message+request+outbox)
                                                             │  idempotent on (shop, source, submission_id)
                                                             ▼
                                        transactional outbox ──relay──▶ pg-boss ──▶ worker
   worker stages:  intake(→awaiting_pipeline) ──▶ AI pipeline ──▶ orders ──▶ (email the one question)
                                                   │  reserve budget → gateway.extract → validate (I3)
                                                   │  → settle(real cost) → decide (code) → persist
                                                   ▼
                              LlmGateway ─▶ ResilientGateway ─▶ LiteLLM proxy ─▶ OpenAI
                              (fake offline)   (breaker/bulkhead/paused)   (holds the key)
```

## The AI boundary (D5/D6/I3)
The model returns a strict Zod-validated form (bikes, reported issues, **catalog service codes from the
fixed 12**, wheels, urgency, the customer's own date words). Code re-validates every field and every
service code against the live catalog; anything failing is never persisted (I3) — one escalation retry,
then `needs_review`. A deterministic **FakeGateway** drives tests/offline; the real adapter calls a
**LiteLLM proxy** (internal-only, digest-pinned) with strict JSON-schema structured output. The prompt
carries no prices, tools, memory, or shop-list (D14 injection containment); the m-1024 "set prices to 0"
test shows code pricing the order normally.

## Isolation (I1, D2)
Enforced by PostgreSQL, not app memory: `shop_id` on every row, **row-level security enabled and
forced**, a non-owner runtime role (`app_user`) with no bypass, and composite foreign keys so a child
row can never reference another shop's parent. Shop identity always comes from the authenticated
credential (API key, signed web-form token, or signed reply token) — never a body or URL. A separate
`app_admin` role (also no-bypass, permissive policy) handles the documented cross-shop provisioning and
credential-lookup path. Attack tests hit the DB **directly as `app_user`**, not only via the API.

## Money (I4/I5, D7/D8)
Prices are integer cents, computed in code as `catalog price × quantity` and **snapshotted** on the
work-order line (a later catalog change never rewrites history). AI spend is integer **micros**. Budget
enforcement is **LiteLLM-native** (constitution 2.0.0, sole authority): one team per shop + restricted
virtual keys (worker never uses the master key), fail-closed admission (over-budget → 422 →
`held_budget`), proxy-calculated cost recorded per request; the proxy has its own isolated Postgres.
Verified at zero cost via a mock-priced upstream. **Measured limitation:** enforcement is
eventually-consistent (bounded one-in-flight-call overshoot) → I4 is a bounded soft cap;
`BUDGET_AUTHORITY=legacy` restores Riverbend's reserve-then-settle hard cap for rollback.

## Failure is normal (VI, D13/D15)
Every outgoing call has a timeout; **one** layer retries (pg-boss, the sole retry authority). Around the
model call, a `ResilientGateway` adds a circuit breaker, a **per-shop bulkhead** (one noisy shop can't
starve others), and a global **AI-paused** switch. Every failure ends in a state a person can see:
transient exhaustion → `needs_review`; at cap/paused → `held_budget`; a failed email → `needs_review`
(the work is never rolled back). No accepted message is lost — the outbox + reconciler guarantee
delivery; a redelivered job replays idempotently with no second charge.

## Communication (I8, D10/D11)
The web form makes email mandatory (the reply path) and defends the public endpoint (CSP, honeypot,
rate limit, origin allowlist, bot check behind an interface). Email uses a transactional outbox for the
one clarification question and a **signed inbound webhook** with `reply+<token>@` correlation and
Message-ID de-duplication; exactly one clarification round (DB-unique follow-up, I6).

## Key trade-offs
- **Modular monolith over microservices**: one deploy, in-process calls, boundaries enforced by tooling
  — right for this scale; split later along the existing module seams if needed.
- **Code owns decisions, model fills a form**: more code, but the only way to make pricing, isolation,
  and injection testable and safe.
- **Two budget layers (transitional)**: LiteLLM enforces + Riverbend stays authoritative until native
  enforcement is proven — defense-in-depth, honestly flagged, no silent regression of I4.
- **Deterministic fake + gated live**: the whole system is verifiable for free (88 tests, a 40-message
  deterministic eval); the paid provider run is gated and cost-bounded.

## What breaks first at 100 shops
Worker queue-depth autoscaling (fixed count today) backs up first under a burst; then Cloud SQL
connection budget (needs a transaction-mode pooler, verified against RLS `set_config` + pg-boss); then
provider rate limits/spend (contained per-shop, but a chain-wide spike needs the aggregate cap + quota
tuning). A single regional Postgres serves everyone — read-replicas/sharding come before analytics grow.
