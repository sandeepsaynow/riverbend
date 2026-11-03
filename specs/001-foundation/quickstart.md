# Quickstart & Validation: 001-foundation

A run/validation guide proving the foundation works end-to-end. It references
[data-model.md](./data-model.md) and [contracts/openapi.yaml](./contracts/openapi.yaml) rather than
repeating them. No implementation code here — that lives in `tasks.md` / the implement phase.

## Prerequisites

- Docker + Docker Compose, Node 22 LTS, `make`.
- A `.env` created from `.env.example` with every required setting filled (the app refuses to start
  otherwise — that is itself validated below).
- `catalog/catalog.json` present (the brief's authoritative 12-service file; a schema-valid fixture
  until it is supplied — see research R8).

## One-command run (FR-012, SC-004)

```sh
make up        # builds the image, starts PostgreSQL + the api process, applies migrations, seeds the catalog
make down      # stops and removes everything
```

**Expected**: `make up` reaches a ready state in under 2 minutes on a laptop; the api listens on
`http://localhost:8080`.

## Validation scenarios

Each maps to a user story / FR and becomes an automated test in `/speckit-tasks`.

### V1 — Liveness & readiness (US3, FR-013, SC-008)

```sh
curl -s localhost:8080/healthz      # => {"status":"alive"}
curl -si localhost:8080/readyz      # => 200 {"status":"ready"} once migrated
```

- Liveness and readiness are **independent**: stopping PostgreSQL makes `/readyz` return **503**
  `{"status":"not_ready","reasons":["db_unreachable"]}` while `/healthz` stays `alive`.
- Readiness checks three things (FR-013) — reachability, migrations/schema compatibility, and that
  the shop-isolation policies are present and forced (verified at runtime via the DB catalog). Each
  failure surfaces a machine-readable reason: `db_unreachable`, `migrations_pending`,
  `schema_incompatible`, `security_policy_missing`. Configuration validity is a startup check
  (FR-014/refuse-to-start), not a readiness reason.
- **Migrate-before-serve / fail-closed (FR-022)**: starting against a database whose required
  migrations or shop-isolation policies are missing/incompatible → startup **fails**; the api serves
  no protected request. (A transiently reachable-but-unmigrated state reports `migrations_pending`.)

### V2 — Refuse to start on missing config; no committed secrets (US4, FR-014/015, I7)

```sh
# Remove a required setting and start → process exits non-zero, naming the setting.
# Example expectation: "Missing required setting: DATABASE_URL"
gitleaks detect --no-banner        # => no leaks
```

- **Fail-closed credentials (FR-021, SC-009)**: start with `ADMIN_BOOTSTRAP_TOKEN` unset or invalid →
  the system refuses to start and serves **no** protected endpoint; there is no default/hardcoded
  credential to fall back to.

### V3 — Provision a shop + issue a credential, admin-only (US2, FR-005–FR-008, FR-020)

```sh
ADMIN=$ADMIN_BOOTSTRAP_TOKEN       # the bootstrap admin credential from env

# Create a shop (admin credential required)
curl -s -X POST localhost:8080/admin/shops \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"slug":"rb-downtown","time_zone":"America/Chicago"}'      # => 201 Shop

# Issue a shop credential — the secret is shown exactly once
curl -s -X POST localhost:8080/admin/shops/rb-downtown/credentials \
  -H "Authorization: Bearer $ADMIN"                              # => 201 IssuedCredential {secret}
```

- Creating a shop with an existing slug → **409**.
- Re-issuing does **not** return a previous secret (shown once only).
- Using a **shop** credential on any `/admin/*` route → **403** (FR-020).

### V4 — Shop-scoped reads; identity from the credential (US2/US5, FR-001, FR-016)

```sh
SHOP=<secret from V3>
curl -s localhost:8080/v1/shop    -H "Authorization: Bearer $SHOP"   # => the caller's own shop only
curl -s localhost:8080/v1/catalog -H "Authorization: Bearer $SHOP"   # => {catalog_version, services:[12]}
```

- Using an **admin** credential on a `/v1/*` route → **403**.
- The catalog returns **exactly 12** services, each with an integer `price_cents` (SC-007).

### V5 — Shop isolation, the headline guarantee (US1, FR-002/003/004, I1)

Provision a second shop (`rb-northside`) and a credential, then:

- **Via API**: `rb-downtown`'s credential calling `/v1/shop` returns only `rb-downtown`; there is no
  path/body parameter that can make it return another shop (identity comes from the key).
- **Direct-to-DB attack (the real proof)**: connect to PostgreSQL **as `app_user`**, bind
  `app.tenant_id` to `rb-downtown`, and run raw `SELECT/UPDATE/DELETE` against `credentials`/`shops`
  targeting `rb-northside`'s rows by id → **zero rows / no effect**, even though the app's own role is
  used and no application filter is applied.
- **Build check (FR-004)**: the CI policy check lists every `tenant_id` table and **fails** if one
  lacks a forced RLS policy. Temporarily add an unpoliced `tenant_id` table in a branch → CI red.

### V6 — Credential lifecycle (US2, FR-007/009/010)

- Issue **two** shop credentials → **both** authenticate; each updates its own `last_used_at`.
- **Revoke one** → that one returns **401** on next use; the other still works (FR-009).

## Done (slice exit criteria)

- `make up` → ready; all V1–V6 scenarios pass as automated tests (Vitest + supertest + Testcontainers).
- Constitution gates for 001 hold: I1 (V5), I5 (V4), I7 (V2) each have a passing named test.
- No functionality from later slices is present (no AI, intake, orders, web form, email, retries).
