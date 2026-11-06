# Riverbend Cycles — Work-Order Intake

Multi-tenant work-order intake for a chain of three bike shops. Messy inbound customer messages (web
form, email, JSON API) become **schema-validated work orders**, where the AI model only *interprets*
text into structure and **code owns every decision, price, and side effect**.

Built slice by slice (001–008); each slice has a spec under [`specs/`](specs/) and a short decision
record in [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md). The permanent rules are
in the [constitution](.specify/memory/constitution.md).

## Reviewer — start here

```sh
docker compose up --build        # Postgres + api + worker; migrates, seeds, serves on http://localhost:8080
# or, if host :5432 is busy / you want the browser portal + Swagger locally:
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm up -d --build
```

- **Demo mode is deterministic** — with no API keys the AI uses an offline `FakeGateway` (no cost, no
  network); real OpenAI/Resend activate only when their keys are set (see Environment below). We do **not**
  fake real email/LLM.
- **Evaluate the 40 sample messages:** `make eval` (deterministic) → writes `docs/results.md`; real-model
  `make eval-live` → `docs/results-live.md`. **Live run (2026-11-06, real `openai/gpt-4o-mini`):** 40 messages,
  38 real OpenAI calls → **36 work orders, 0 follow-ups, 0 failures**, 1 price answer, 2 needs-review,
  1 idempotent replay; order value **$2,014**; **measured spend $0.0052** (LiteLLM `/global/spend` corroborates;
  well under the $20 cap). Deterministic run: 32/4/0, $1,865 (est. $0.074, labelled). On ambiguous messages the
  live model extracts where the deterministic run asks a question, so the deterministic run stays authoritative
  for regression. Full report: [`docs/evaluation-results.md`](docs/evaluation-results.md).
- **Tests:** `npm test` (or `make test`) — unit + integration on **real PostgreSQL** via Testcontainers
  (Docker required); **220 passing**.
- **Submission docs:** [architecture note](docs/architecture.md) (2-page, Mermaid) ·
  [Not Built & scaling](docs/not-built.md) · [evaluation results](docs/evaluation-results.md) ·
  [GCP deployment](docs/gcp-deployment.md) (`infra/terraform/`) · [manual test walkthrough](docs/FINAL_MANUAL_TEST.md) ·
  [submission checklist](docs/submission-checklist.md) · decisions in [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md).
- **Stack (actual):** Express 5 + PostgreSQL 16 (forced RLS) + **pg-boss** (Postgres queue, no Redis) +
  Better Auth + Resend + a LiteLLM proxy over OpenAI. No Next.js, no Redis.

## Quick start (one command, no API key)

Requires Docker. The default run is fully offline — the AI uses a deterministic **FakeGateway**, so
nothing needs a provider key.

```sh
# Full hands-on acceptance walkthrough (browser + live AI/email): see docs/FINAL_MANUAL_TEST.md.
# If host :5432 is taken, use the local overlay:
#   docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm up -d --build
ADMIN_BOOTSTRAP_TOKEN=some-long-random-secret make up   # Postgres + api + worker; migrates, seeds, serves
# waits for http://localhost:8080/readyz
make down
```

End-to-end demo (admin bearer is `rb_admin_bootstrap.<ADMIN_BOOTSTRAP_TOKEN>`):

```sh
A="Bearer rb_admin_bootstrap.some-long-random-secret"
curl -X POST localhost:8080/admin/shops -H "$A" -H 'Content-Type: application/json' \
     -d '{"slug":"rb-downtown","time_zone":"America/Chicago"}'
KEY=$(curl -s -X POST localhost:8080/admin/shops/rb-downtown/credentials -H "$A" | jq -r .secret)
curl localhost:8080/v1/catalog -H "Authorization: Bearer $KEY"          # 12 services, version cat-001
# submit a message (idempotent on shop+source+submission_id); 202 + status URL
curl -X POST localhost:8080/v1/messages -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"source":"email","submission_id":"m-1001","content":"my road bike needs a tune-up"}'
curl localhost:8080/v1/requests/<id> -H "Authorization: Bearer $KEY"    # state → ordered
curl localhost:8080/v1/orders        -H "Authorization: Bearer $KEY"    # the code-priced work order
```

### Real AI (OpenAI via the LiteLLM proxy) — optional

Approved architecture: **worker → `LlmGateway` → LiteLLM proxy → OpenAI** (D6). Set the keys in `.env`
(see `.env.example`) and start the proxy with the stack:

```sh
docker compose --profile llm up     # adds the internal-only LiteLLM proxy (holds the provider key)
```

The proxy is the only component with the provider key; the worker talks to it with a restricted proxy
key. Spend is tracked in micros under a per-shop monthly cap (see "Budget" below).

### Web form (005)

Set `WEB_FORM_SIGNING_KEY` in `.env`, then open `http://localhost:8080/f/rb-downtown` — a public
per-shop form with mandatory email, refresh-safe submission ids, honeypot/CSP/rate-limit/origin
defences, and a bot check behind a Turnstile interface (offline fake passes). Status page at
`/f/status/<signed-token>`.

### Email (006)

Set `EMAIL_SIGNING_KEY` + `RESEND_API_KEY`. The worker emails the one clarification question through
**Resend** (D21). Offline (no keys) uses an in-memory no-op transport. Inbound replies arrive by one of
two modes; both fetch full content from the Receiving API, correlate by the signed `reply+<token>@`,
de-duplicate (Message-ID), and resume the pipeline:

1. **Resend API polling (default local/MVP, D21.1) — no public URL, webhook, or tunnel.** The worker lists
   received emails every `RESEND_POLL_INTERVAL_SECONDS` (default 60), discovers new ones, and processes
   them. On by default when `RESEND_API_KEY` + `EMAIL_SIGNING_KEY` are set. **Reviewer demo:** trigger a
   clarification in-app, then reply from any mailbox to the `reply+<token>@<id>.resend.app` address — within
   a poll interval the worker resumes the request and the staff console shows the update.
2. **Webhooks (optional, production — lower latency).** Set `RESEND_WEBHOOK_SECRET` + a dashboard webhook to
   `POST <public-url>/webhooks/resend` (Svix-verified). Pushes `email.received` immediately. May run
   alongside polling (Message-ID dedup → one effect).

**New inbound email → new work order (D25).** A brand-new customer email (no reply token) creates a **new**
request, attributed to the shop that owns the **verified destination address** — never the sender. The map
is `shops.inbound_address`; `make provision` sets one address per shop (`<slug>@$RESEND_INBOUND_DOMAIN`, set
`RESEND_INBOUND_DOMAIN` to your verified receiving domain in production). An email to an unknown or ambiguous
recipient is safely ignored; duplicates collapse by Message-ID. This is distinct from a reply (above), which
resumes an existing request. Covered by `tests/integration/email-new-inbound.test.ts`.

This exercises the **real Resend provider API** (list + retrieve); it is provider-API integration testing,
distinct from complete customer-email delivery (which needs a verified sending domain). See
`specs/006-email/quickstart.md`.

### Evaluation (008)

```sh
make eval        # replays the brief's 40 sample messages (deterministic, free) → docs/results.md
make eval-live   # same, through the real provider (gated; costs money; keep spend < USD 20)
```

[`docs/results.md`](docs/results.md) is a real run read back from the database (not fabricated).

### Staff portal — human login (010)

Set `BETTER_AUTH_SECRET` (+ `ADMIN_BOOTSTRAP_TOKEN`) and `make up`. **Human** auth is **Better Auth**
(email/password, sessions) and is separate from the machine `/v1` shop API keys and the internal
LiteLLM virtual keys. One-time admin init, then browser login:

```sh
# 1) one-time first-admin init (operator; single-use, bootstrap-token gated)
curl -X POST localhost:8080/admin/init -H 'Content-Type: application/json' \
     -d "{\"bootstrap_token\":\"$ADMIN_BOOTSTRAP_TOKEN\",\"email\":\"admin@you.com\",\"password\":\"<≥12 chars>\",\"name\":\"Admin\"}"
# 2) browser: http://localhost:8080/admin/login  → /admin → /admin/staff (create staff: email, password, shop, role)
# 3) browser: http://localhost:8080/staff/login   → /staff dashboard, /staff/requests, /staff/orders,
#             /staff/needs-attention, /staff/usage  — each staff sees ONLY their assigned shop.
```

Sessions are HttpOnly cookies (Secure in production); disabling a staff account revokes its session and
blocks re-login. Passwords are hashed by Better Auth (never stored/returned as plaintext). The portal is
off unless `BETTER_AUTH_SECRET` is set.

### Admin, credentials & local demo (009)

API docs: **Swagger UI at `http://localhost:8080/docs`** (+ `/openapi.json`) — non-production only.

No-SQL local setup (against a running `make up`): **`make provision`** ensures the three shops and
issues a shop API key each (shown once; idempotent — it never rotates an existing active key; use
`make provision ROTATE=1` to replace). Then:

```sh
KEY=rb_shop_...        # from `make provision` output (copy once)
A="Bearer rb_admin_bootstrap.$ADMIN_BOOTSTRAP_TOKEN"   # operator credential
# submit a REAL OpenAI-backed request (needs `docker compose --profile llm up` + keys in .env):
curl -X POST localhost:8080/v1/messages -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"source":"email","submission_id":"demo-1","content":"my road bike needs a tune-up"}'
curl localhost:8080/v1/requests/<id>      -H "Authorization: Bearer $KEY"   # watch it reach ordered
curl localhost:8080/v1/orders             -H "Authorization: Bearer $KEY"   # code-priced work order
curl localhost:8080/v1/needs-attention    -H "Authorization: Bearer $KEY"
# credential lifecycle (operator):
curl -X POST localhost:8080/admin/shops/rb-downtown/credentials -H "$A" -H 'Content-Type: application/json' \
     -d '{"name":"ops","scopes":["orders:read"],"expires_in_days":30}'     # issue (secret shown once)
curl localhost:8080/admin/shops/rb-downtown/credentials -H "$A"            # list MASKED (no secret)
curl -X POST localhost:8080/admin/credentials/<id>/rotate -H "$A"          # rotate
curl -X POST localhost:8080/admin/credentials/<id>/revoke -H "$A"          # revoke → key now 401
```

- **Switch shops:** use a different shop's `$KEY`. **Prove isolation:** shop B's key on shop A's
  `request_id` → `404`. **Revoke & verify:** after revoke, the key returns `401`.
- **Customer web form:** `http://localhost:8080/f/rb-downtown` (needs `WEB_FORM_SIGNING_KEY`).
- **Email (Resend, D21):** outbound + inbound via Resend; no local mail UI. Offline runs no-op outbound.
- **Three key kinds:** admin credential (operator) · shop API key (tenant) · LiteLLM virtual key
  (internal, never exposed). Use the **real AI** (proxy), not the FakeGateway, for the live demo.

## Configuration

Every setting comes from the environment; the app **refuses to start** if a required one is missing,
and **no secret has a default**. Copy [`.env.example`](.env.example) to `.env`. Required: the three
`DATABASE_*` URLs + `ADMIN_BOOTSTRAP_TOKEN`. Everything for the AI provider, web form, email, and
resilience is **optional** and off unless set, so the default run stays keyless.

## Development

```sh
npm install
npm run typecheck   # strict TypeScript (NodeNext, exactOptionalPropertyTypes)
npm run lint        # dependency-cruiser module boundaries
npm test            # Vitest: unit + contract + real-PostgreSQL integration (Testcontainers; needs Docker)
```

Current suite: **88 passing** (unit + contract + real-Postgres integration). CI additionally runs
gitleaks and `terraform validate` ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## The guarantees (invariants)

Isolation is enforced **by PostgreSQL** (forced RLS, no-bypass `app_user`, composite FKs), not app
code; shop identity always comes from the authenticated credential. The eight invariants (I1 isolation,
I2 one order per request+bike, I3 validate-before-persist, I4 per-shop monthly cap, I5 catalog pricing
in cents, I6 ≤1 follow-up, I7 no committed secrets, I8 reply path) each have a named test.

**Deterministic business-rule guards** keep the model honest where the real 40-message eval found it
err: broad delegation ("whatever it needs") is routed to a **general inspection**, never an invented
repair list (m-1025); a message addressing a **different shop** ("Hi Lakeshore team!") goes to
`needs_review`, never an order or tenant transfer (m-1009); and a **model-invented extra bicycle** is
dropped unless the message signals more than one (m-1032). Code owns the outcome, not the model. See
`docs/results-live.md` (post-fix) vs `docs/results-live-before-guards.md` (pre-fix).

### Budget (I4) — LiteLLM-native (sole authority, 2.0.0)

Per constitution **2.0.0** + D7, **LiteLLM is the sole active budget authority**: one **team per shop**
($5/month), restricted **virtual keys** the worker selects server-side (never the master key — that is
provisioning-only), fail-closed admission (over-budget → HTTP 422 → `held_budget`), and proxy-calculated
cost (`x-litellm-response-cost`) recorded per request for accounting. It has its **own isolated Postgres
database**. Verified end-to-end at **zero cost** with a mock upstream + configured pricing (no paid
calls): cost capture, budget rejection, tenant isolation, master-key-not-inference, no-double-count.

**Honest limitation (measured):** native enforcement is eventually-consistent, so it can exceed a cap by
**at most one in-flight call** — I4's guarantee was amended from a hard cap to this bounded soft cap
(per-call cost ≈ micros, so immaterial against $5). `BUDGET_AUTHORITY=legacy` restores Riverbend's
reserve-then-settle **hard cap** for rollback or a shop that needs one. See [`docs/decision-log.md`](docs/decision-log.md).

## Feature status

| Slice | What | State |
|---|---|---|
| 001 foundation | run, provisioning, forced-RLS isolation, catalog | ✅ |
| 002 intake/queue | 202 intake, idempotency, outbox + pg-boss, needs_review | ✅ |
| 003 AI pipeline | strict extraction (I3), decide, one-question (I6), budget ledger | ✅ (FakeGateway + real OpenAI via proxy) |
| 004 orders | one order/bike (I2), code pricing + snapshot (I5), staff reads | ✅ |
| 005 web form | per-shop form, mandatory email, defences, status page | ✅ |
| 006 email | outbound question, inbound webhook/poll + content fetch, reply resumption, **new-inbound → new request by verified address (D25)**, dedupe, delivery status | ✅ (Resend, D21/D25) |
| 007 resilience | per-call timeout, bounded pg-boss retry+DLQ, circuit breaker, per-shop bulkhead, AI-paused switch, **429≠budget + held_budget auto-recovery (D25)** | ✅ (core) |
| 008 eval + deploy | 40-message eval (deterministic **+ live real-model run, 2026-11-06**); GCP Terraform (validated) | ✅ (both evals run; live GCP deploy gated) |

## Not built / deferred (honest scope, IX)

- ~~**Live 40-message eval + real provider cost report**~~ — **DONE 2026-11-06** (real `openai/gpt-4o-mini`
  via LiteLLM; 38 real calls; measured spend **$0.0052**). Results in `docs/results-live.md`; run it yourself
  with `docker compose --profile llm up -d db litellm && EVAL_LLM_BASE_URL=http://localhost:4000/v1 make eval-live`.
- **LiteLLM-native budget as sole authority** — per-shop team/virtual-key provisioning + the
  concurrency-atomicity acceptance test; deferred because it cannot be validated without paid
  budget-exhaustion calls (legacy ledger remains authoritative).
- **Verified-channel cancellation** (m-1038) and **server-rendered staff HTML** (D9/D17) — staff data
  is exposed as JSON reads; cancellation routes to `needs_review`.
- **OpenTelemetry/Phoenix tracing, the alert set, and the retention/TTL sweeper** (007) — designed, not
  wired; PII-safe ids-only logging already holds (VII).
- **Live GCP deploy** — IaC + `terraform validate`/`plan` only; no `apply` (B2).

## What breaks first at 100 shops

- **Worker scaling**: the worker does not autoscale on queue depth (fixed Cloud Run count) — the AI
  pipeline backs up first under a burst. Fix: a depth-driven autoscaler or a GKE/MIG worker pool.
- **Cloud SQL connections**: pods × per-pod connection limit must stay under `max_connections`; add a
  transaction-mode pooler and verify RLS `set_config` + pg-boss survive it.
- **Provider rate limits / spend**: the per-shop cap + circuit breaker contain this, but a chain-wide
  spike needs the aggregate cap and provider-side quotas tuned.
- **Single Postgres**: one regional instance serves all shops; sharding/read-replicas come well before
  100 busy shops if analytics/reporting grow.

## Hours

> **TODO (owner):** record the real hours spent here before submitting (Constitution IX requires the
> true figure; it is intentionally not guessed).

See also the 2-page [architecture note](docs/ARCHITECTURE_NOTE.md).

> `catalog/catalog.json` is the authoritative 12-service catalog from the brief, verbatim; only the
> internal `catalog_version` is added.

> **Portal login:** browse the canonical origin (`http://localhost:8080`, or `127.0.0.1:8080` in dev); login/create-staff/disable/logout carry a CSRF token automatically (D20.3). Scripting login with curl needs the CSRF flow — see docs/FINAL_MANUAL_TEST.md.

> **Customer form (D24):** each form load uses a fresh operation id, so multiple requests from one browser all succeed; a double-click/retry dedupes. See docs/FINAL_MANUAL_TEST.md.
