# Riverbend Cycles — Work-Order Intake

Multi-tenant work-order intake for a chain of bike shops. This repository is built **slice by
slice** (see [docs/IMPLEMENTATION_SLICES.md](docs/IMPLEMENTATION_SLICES.md)). The current slice is
**001-foundation** — the runnable, provisionable, multi-tenant base. **It performs no AI work.**

## Quick start (one command)

Requires Docker.

```sh
ADMIN_BOOTSTRAP_TOKEN=some-long-random-secret make up   # Postgres + api; migrates, seeds, serves
# ... waits until http://localhost:8080/readyz reports ready
make down                                                # stop and remove everything
```

Then (the admin bearer token is `rb_admin_bootstrap.<ADMIN_BOOTSTRAP_TOKEN>`):

```sh
A="Bearer rb_admin_bootstrap.some-long-random-secret"
curl localhost:8080/healthz                                              # {"status":"alive"}
curl localhost:8080/readyz                                               # {"status":"ready"}
curl -X POST localhost:8080/admin/shops -H "$A" -H 'Content-Type: application/json' \
     -d '{"slug":"rb-downtown","time_zone":"America/Chicago"}'
KEY=$(curl -s -X POST localhost:8080/admin/shops/rb-downtown/credentials -H "$A" | jq -r .secret)
curl localhost:8080/v1/shop    -H "Authorization: Bearer $KEY"           # the caller's own shop
curl localhost:8080/v1/catalog -H "Authorization: Bearer $KEY"           # 12 services, version cat-001
```

The HTTP contract is [specs/001-foundation/contracts/openapi.yaml](specs/001-foundation/contracts/openapi.yaml).

## Configuration

All settings come from the environment; the app **refuses to start** if a required one is missing
or empty, and **no secret has a default**. Copy [`.env.example`](.env.example) to `.env`. Required:
`DATABASE_URL` (role `app_user`), `DATABASE_ADMIN_URL` (role `app_admin`), `DATABASE_MIGRATOR_URL`
(owner), `ADMIN_BOOTSTRAP_TOKEN`. Optional: `PORT` (8080), `LOG_LEVEL` (info).

## Development

```sh
npm install
npm run typecheck   # strict TypeScript
npm run lint        # dependency-cruiser module boundaries
npm test            # Vitest: unit + contract + real-PostgreSQL integration (Testcontainers; needs Docker)
```

## How isolation works (the headline guarantee)

Shop isolation is enforced **by PostgreSQL**, not application code: every shop-owned row carries
`shop_id`, row-level security is **enabled and forced**, and the runtime role `app_user` has no
bypass — so a forgotten `WHERE` clause cannot leak another shop. Shop identity always comes from the
authenticated credential, never the request body or path. A separate `app_admin` role (also no
bypass, permissive policy) handles the cross-shop provisioning/credential-lookup path. See
[specs/001-foundation/data-model.md](specs/001-foundation/data-model.md) and
[docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md) (D2).

## Time zones (Q-TZ)

Each shop stores a named IANA time zone, set at creation. The three sample shops use
`America/Chicago` by default in examples; change per shop as needed. (Date/cap logic that consumes
the zone arrives in later slices.)

## Scope — what this slice is and is not

**Built (001):** one-command run; shop + credential provisioning (admin path, fail-closed bootstrap);
database-enforced isolation proven by direct-to-DB attack tests; liveness + three-check readiness
(reachable + migrated/compatible + isolation policies forced); fail-fast config; no committed
secrets (gitleaks); the 12-service versioned catalog.

**Not built here (later slices):** message intake & idempotency (002); the AI pipeline, follow-ups
and spend ledger (003); work orders, pricing and the staff screen (004); the web form (005); email
(006); resilience/tracing (007); the 40-sample evaluation and GCP deploy (008). A **not-built list,
real hours, and "what breaks first at 100 shops"** are finalized in slice 008.

> Note: `catalog/catalog.json` is the **authoritative** 12-service catalog from the take-home brief,
> verbatim (tasks.md T056 resolved); only the internal `catalog_version` is added for FR-018.
