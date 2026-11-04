# Riverbend Cycles — Work-Order Intake

Multi-tenant work-order intake for a chain of three bike shops. Messy inbound customer messages (web
form, email, JSON API) become **schema-validated work orders**, where the AI model only *interprets*
text into structure and **code owns every decision, price, and side effect**.

Built slice by slice (001–008); each slice has a spec under [`specs/`](specs/) and a short decision
record in [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md). The permanent rules are
in the [constitution](.specify/memory/constitution.md).

## Quick start (one command, no API key)

Requires Docker. The default run is fully offline — the AI uses a deterministic **FakeGateway**, so
nothing needs a provider key.

```sh
ADMIN_BOOTSTRAP_TOKEN=some-long-random-secret make up   # Postgres + api + worker + Mailpit; migrates, seeds, serves
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

Set `EMAIL_SIGNING_KEY`. The worker emails the one clarification question through **Mailpit** (UI at
`http://127.0.0.1:8025`); customer replies arrive at the signed inbound webhook `POST /webhooks/email`,
are correlated + de-duplicated, and resume the pipeline.

### Evaluation (008)

```sh
make eval        # replays the brief's 40 sample messages (deterministic, free) → docs/results.md
make eval-live   # same, through the real provider (gated; costs money; keep spend < USD 20)
```

[`docs/results.md`](docs/results.md) is a real run read back from the database (not fabricated).

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

### Budget (I4) — LiteLLM-native, with a safe fallback

Per the amended constitution (1.2.0) and D7, per-shop budget **enforcement** moves to LiteLLM-native
team/virtual-key budgets (fail-closed, calendar-month reset administered by Riverbend). This repo ships
the verifiable pieces — **real proxy-cost capture** (`x-litellm-response-cost`) and **fail-closed
`held_budget`** on a proxy rejection — behind a dual-path design; the legacy reserve-then-settle ledger
remains the active, tested authority until the native "N concurrent → exactly K" acceptance test can be
run **without paid budget-exhaustion calls**. See [`docs/decision-log.md`](docs/decision-log.md).

## Feature status

| Slice | What | State |
|---|---|---|
| 001 foundation | run, provisioning, forced-RLS isolation, catalog | ✅ |
| 002 intake/queue | 202 intake, idempotency, outbox + pg-boss, needs_review | ✅ |
| 003 AI pipeline | strict extraction (I3), decide, one-question (I6), budget ledger | ✅ (FakeGateway + real OpenAI via proxy) |
| 004 orders | one order/bike (I2), code pricing + snapshot (I5), staff reads | ✅ |
| 005 web form | per-shop form, mandatory email, defences, status page | ✅ |
| 006 email | outbound question, signed inbound webhook, reply resumption, dedupe | ✅ (Mailpit) |
| 007 resilience | circuit breaker, per-shop bulkhead, AI-paused switch | ✅ (core) |
| 008 eval + deploy | 40-message eval + results.md; GCP Terraform (validated) | ✅ (deterministic eval + IaC; live eval + deploy gated) |

## Not built / deferred (honest scope, IX)

- **Live 40-message eval + real provider cost report** — gated on real LLM credentials (B1). The
  harness + deterministic run exist; `make eval-live` runs the paid version.
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
