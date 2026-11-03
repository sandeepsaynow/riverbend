# Phase 0 Research: 001-foundation

**Method note.** Per the slice loop (`IMPLEMENTATION_SLICES.md`), technology must *match the
recorded decisions D1–D18*, not introduce a fresh opinion. The one-way-door choices for this slice
(tenancy model, money format, public contracts) are already decided in
`docs/ARCHITECTURE_DECISIONS.md`; this file records them as resolved and settles only the remaining
**reversible, plan-level** choices (test runner, migration tool, query layer, the concrete
administrative-auth mechanism, the time-zone default, and the catalog file). No research subagents
were dispatched: they would lack the decisions-doc context and risk contradicting D1–D18. Items the
Architecture Guide flagged as unverified (Appendix E) that touch later slices — pg-boss, Cloud SQL
pooling, LiteLLM budgets — are out of scope here.

Each entry: **Decision → Rationale → Alternatives considered.** All resolved; **no NEEDS
CLARIFICATION remain.**

## R1. Language, framework, HTTP stack (D12)

- **Decision**: TypeScript 5.x on Node 22 LTS; Express 5 with Zod-validated typed routes; `helmet`,
  `express-rate-limit`, `pino-http`. Business logic never imports the framework.
- **Rationale**: Directly D12. Express 5 forwards async errors to the error handler (removes a class
  of unhandled-rejection bugs). Zod route contracts give runtime validation + inferred types; a
  contract test fails the build if a route lacks schemas. This reverses the guide author's earlier
  Fastify lean ("your idea wins", D12) — recorded, not re-opened.
- **Alternatives considered**: Fastify (rejected per D12); NestJS (too much framework in the business
  layer, violates Principle IV separation). Door: two-way — the framework sits behind `platform/http`.

## R2. Database + tenant isolation (D2, Principle III) — one-way door, already decided

- **Decision**: PostgreSQL 16. Every shop-owned table carries `shop_id` (`tenant_id`). RLS is
  `ENABLE` **and** `FORCE`. The app connects as a non-owner role `app_user` (no `BYPASSRLS`);
  migrations run as a separate owner/migrator role. The current shop is set per transaction with
  `SELECT set_config('app.tenant_id', $1, true)` and RLS policies compare `shop_id` to
  `current_setting('app.tenant_id')`. Shop id is taken from the authenticated credential only.
  Cross-shop referencing uses the **composite-key convention**: shop-owned parents expose
  `UNIQUE (id, shop_id)` and shop-owned children reference `(parent_id, shop_id)`, so a row can never
  point at another shop's row.
- **Rationale**: D2 verbatim; realises FR-001/002/003 and invariant I1. Enforcing isolation in the
  database means a forgotten `WHERE shop_id = …` in application code cannot leak data.
- **Scope note (honest)**: In 001 the shop-owned tables are `shops` and `credentials`, so the
  composite-FK *convention* is established and documented but the first cross-row composite FK lands
  when a shop-owned child references a shop-owned parent (requests→work orders, slice 002+). The RLS
  attack test in 001 runs against `credentials` (a `tenant_id` table) and `shops`.
- **Alternatives considered**: database-per-shop / schema-per-shop (rejected in D2 — adding `tenant_id`
  later is the expensive one-way move; per-shop physical separation is the documented escape hatch,
  not the default); application-level filtering only (rejected — a single missed filter breaks
  tenancy; Principle III forbids it).

## R3. Migrations + query layer (reversible)

- **Decision**: Raw-SQL migrations via `node-pg-migrate`, applied by a migration runner (a
  `make migrate` command / compose job) as the owner role, using **expand-and-contract** (D18).
  Queries use `pg` (node-postgres) with a thin typed query helper in `platform/db`; **no ORM**.
- **Rationale**: Forced RLS, `FORCE ROW LEVEL SECURITY`, composite FKs, non-owner roles, and per-tx
  `set_config` all need precise SQL that ORMs obscure or fight. Raw SQL keeps the one-way-door DB
  decisions explicit and reviewable.
- **Alternatives considered**: Prisma (weak/awkward RLS + role separation; generates its own client
  role assumptions) — rejected. Drizzle (nicer, but still an abstraction over the exact SQL we most
  need to see) — rejected for this slice; could be revisited behind `platform/db` (two-way door).

## R4. Testing strategy (Principle VIII)

- **Decision**: Vitest runner. `supertest` for HTTP contract tests. **Testcontainers** starts a real
  ephemeral PostgreSQL for integration tests; the isolation attack test connects **as `app_user`**
  and attempts cross-shop reads/updates/deletes with raw SQL (not only through the API). A build/CI
  check enumerates `tenant_id` tables and fails if any lacks a forced policy (FR-004). Unit tests
  cover config refuse-to-start, whole-cent validation, and credential hashing/last-used.
- **Rationale**: Constitution VIII requires isolation/uniqueness/concurrency tests against a *real*
  PostgreSQL — mocks cannot prove RLS. Testcontainers gives a real, disposable instance in CI.
- **Alternatives considered**: a shared dockerised test DB via compose (works, but less hermetic
  across parallel runs) — acceptable fallback, documented; an in-memory/SQLite shim (rejected — cannot
  exercise RLS, would prove nothing).

## R5. Credentials & administrative authorization (D14, FR-007–FR-010, FR-020)

- **Decision**: API credentials are opaque tokens shown once, formatted `rb_<kind>_<prefix>.<secret>`.
  Stored as **prefix + SHA-256 fingerprint** of the secret (never the secret); verified by
  prefix-lookup then **constant-time compare**; each has status (active/revoked) and a `last_used_at`
  updated on authentication. A shop may hold **multiple active** credentials; revoke is per-credential.
  There are two credential **kinds**: `shop` (bound to one shop, carries the tenant identity) and
  `admin` (not bound to a shop). **Administrative actions** (create shop, issue/revoke credential)
  require an `admin` credential and are served on a separate route group; shop routes reject `admin`
  credentials and vice-versa, and a `shop` credential can never provision (FR-020). **Bootstrap**: on
  first start the system provisions an initial admin credential from a configured secret
  (`ADMIN_BOOTSTRAP_TOKEN` fingerprint in env) so the very first admin action has a credential before
  any shop exists. This path is **fail-closed** (FR-021): the token is validated at startup, no
  protected endpoint is served without it, and there is **no default or hardcoded credential** — a
  missing or invalid token aborts startup (consistent with FR-014).
- **Rationale**: D14 (hashed, revocable, per-shop keys; prefix + SHA-256; constant-time; rotation via
  multiple active keys; last-used). The admin/shop split realises FR-020's least-privilege posture and
  solves the chicken-and-egg of provisioning the first shop.
- **Alternatives considered**: single key kind with an elevated shop (rejected — blurs the isolation
  boundary, clarified against in `/speckit-clarify`); unauthenticated trusted-operator provisioning
  (rejected — clarified against; also unsafe once the service is not purely local). Door: the concrete
  bootstrap-secret delivery is two-way (env now; Secret Manager in prod per D14/D18).

## R6. Configuration & secrets (FR-014/FR-015, I7, D14/D15)

- **Decision**: All settings parsed from the environment through one typed Zod schema at startup; a
  missing or empty required value aborts start with a message naming the setting. `.env` is
  git-ignored; `.env.example` lists every key with no values. `gitleaks` runs in CI and as a
  pre-commit hook. Required settings include: `DATABASE_URL` (app_user), migrator DB URL/role,
  `ADMIN_BOOTSTRAP_TOKEN`, token-signing key material (reserved for later customer tokens), log level.
- **Rationale**: FR-014/FR-015, invariant I7, D14/D15 "never commit a secret; validate settings at
  startup; refuse to start without them."
- **Alternatives considered**: lazy/per-use config reads (rejected — fails late and partially);
  committing a populated `.env` for convenience (rejected — violates I7).

## R7. Health & readiness (FR-013, SC-008)

- **Decision**: `GET /healthz` (liveness) returns ok whenever the process is up and is **independent**
  of readiness. `GET /readyz` (readiness) returns ready only when **all** of: (a) data store
  reachable; (b) required migrations applied and schema **compatible** — the exact migration set this
  build requires is present, none missing and no unknown/newer one applied; (c) the required
  shop-isolation policies are present and **forced** on every `tenant_id` table — verified at runtime
  by querying the database's policy catalog (`pg_class.relforcerowsecurity` + `pg_policies`), which
  complements the build-time FR-004 check — otherwise 503 with machine-readable `reasons`
  (`db_unreachable`, `migrations_pending`, `schema_incompatible`, `security_policy_missing`).
  **Configuration is NOT a readiness check**: required settings are validated once at startup and the
  process refuses to start when they are invalid (FR-014), so a running instance always has valid
  config (resolves analyze finding I1). Startup is **migrate-before-serve and fail-closed** (FR-022):
  an incompatible or unpoliced schema aborts startup rather than serving protected requests.
- **Rationale**: Gap-resolution decision (FR-013/FR-022) — reachability alone is not enough; a
  reachable-but-unmigrated or unpoliced instance must not take protected traffic. Keeping liveness
  independent avoids a readiness failure killing the process. The runtime policy probe (catalog
  inspection) is distinct from the FR-004 build-time check: one guards a running database, the other
  guards the build.
- **Alternatives considered**: reachability-only readiness (rejected — a system that will fail on the
  first real query, or leak across shops because a policy is missing, must report not-ready);
  serve-then-migrate (rejected — risks serving against an incompatible schema). A trivial app-role
  query as an extra readiness probe remains an easy future addition. Door: two-way for the probe set.

## R8. Catalog as versioned reference data (FR-016/017/018, D8)

- **Decision**: The twelve services are the **catalog JSON provided with the brief**, committed at
  `catalog/catalog.json` as the single authoritative source and loaded as versioned reference data;
  prices stored as integer cents. The catalog carries a **deterministic version id `cat-NNN`**
  (zero-padded monotonic integer; the brief's catalog is `cat-001`), minted anew only when the
  committed catalog content changes, and `code` is **unique within a version** (`UNIQUE (catalog_version,
  code)`). Shared by all shops (not `tenant_id`-scoped), served read-only to any authenticated shop.
  A loader validates the file against a Zod schema at seed time (exactly 12 services; each with
  `code`, `name`, integer-cent `price`, `minutes`, `requires_inspection`; codes unique); non-whole-cent
  prices are rejected.
- **Rationale**: FR-016 (committed authoritative), FR-017 (whole cents, I5), FR-018 (versioned so a
  later price change never rewrites recorded history — D8 "copy the unit price and catalog version").
- **Dependency (RESOLVED 2026-11-03, T056)**: the authoritative catalog was extracted verbatim from the
  brief PDF ('Catalog' section) into `catalog/catalog.json` — 12 services (`TUNE_BASIC`, `TUNE_FULL`,
  `BRAKE_ADJUST`, `BRAKE_PADS`, `BRAKE_BLEED`, `GEAR_ADJUST`, `CHAIN_REPLACE`, `FLAT_FIX`, `TIRE_REPLACE`,
  `WHEEL_TRUE`, `EBIKE_DIAG`, `GENERAL_INSPECT`), prices/minutes/requires_inspection unchanged; only the
  internal `catalog_version: cat-001` is added (FR-018). No fixture remains in use.
- **Alternatives considered**: hand-encoding the 12 services in a migration (rejected — duplicates the
  brief's data by hand, drifts); loading from a remote source (rejected — reference data should be
  committed and reproducible).

## R9. Module boundaries (D1, Principle IV)

- **Decision**: `dependency-cruiser` config forbids (i) importing a module's internals (only its
  `index.ts`), (ii) a module importing another module's `db`/tables, (iii) business modules importing
  `platform/http` framework types, and (iv) the api process importing worker-only/AI code. Rules run
  in CI and fail the build.
- **Rationale**: Principle IV + D1 — "enforced by a build-time tool, not discipline." Establishing the
  rules in the foundation keeps the monolith from decaying as later slices add modules.
- **Alternatives considered**: ESLint import rules only (weaker graph analysis), Nx/Turbo project
  boundaries (heavier than needed now) — both rejected for this slice; `dependency-cruiser` is the
  decision of record (D1).

## Resolved unknowns summary

| Technical Context field | Resolution | Source |
|---|---|---|
| Language/Version | TypeScript 5.x / Node 22 LTS | D12 (R1) |
| Primary Dependencies | Express 5, Zod, helmet, rate-limit, pino, pg, node-pg-migrate, dependency-cruiser | D12/D2/D1 (R1–R3, R9) |
| Storage | PostgreSQL 16, forced RLS, app_user role | D2 (R2) |
| Testing | Vitest + supertest + Testcontainers | Principle VIII (R4) |
| Admin-auth mechanism | admin vs shop credential kinds; env bootstrap token | D14 (R5) |
| Time-zone default | per-shop IANA zone; single named zone assumed for the 3 samples, documented in README | spec clarification / Q-TZ |
| Catalog file | committed `catalog/catalog.json`; authoritative, verbatim from the brief (T056 resolved) | FR-016 (R8) |

No NEEDS CLARIFICATION remain. Proceed to Phase 1.
