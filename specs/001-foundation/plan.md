# Implementation Plan: Foundation — Shops, Credentials & Isolation

**Branch**: `001-foundation` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-foundation/spec.md`

## Summary

Stand up the runnable, provisionable, multi-tenant base that every later slice builds on, with
**no AI** anywhere in it. The system is one codebase and one container image run as an **api**
process (a **worker** process is scaffolded structurally but does no work until slice 002), backed
by a single **PostgreSQL** database. Shops are the unit of tenancy; isolation is enforced **by the
database** (a `tenant_id` on every shop-owned row, **forced row-level security**, composite-key
referencing convention, and a non-owner application role), not by application filters. Operators
provision shops and issue/revoke per-shop API credentials through an **administrative** auth path
distinct from shop keys. The system reads all config from the environment and **fails closed**: it
refuses to start when a required setting or the administrative bootstrap credential is missing/invalid
(no default/hardcoded credential), applies migrations before serving, and never serves protected
requests against an incompatible or unpoliced schema. Liveness is independent of readiness; readiness
reports ready only when the data store is reachable, migrations are applied/compatible, **and** the
shop-isolation policies are present and forced (verified at runtime via the database catalog);
configuration is validated at startup (FR-014), not at readiness. The twelve-service catalog
is committed as versioned reference data (deterministic `cat-NNN` version, codes unique per version)
with prices in whole cents. Technology choices follow `docs/ARCHITECTURE_DECISIONS.md` **D1, D2,
D12, D14** (and D8's money-in-cents rule); reversible choices are named here and kept behind the
module structure.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS (D12).

**Primary Dependencies**: Express 5 + Zod (typed route contracts), `helmet`, `express-rate-limit`,
`pino`/`pino-http` (D12); `pg` (node-postgres) for queries with per-transaction tenant binding;
`node-pg-migrate` for raw-SQL expand-and-contract migrations (D2/D18); `dependency-cruiser` for
module-boundary enforcement (D1). No ORM (RLS, composite keys, and `set_config` need direct SQL
control). No AI/queue/email dependencies in this slice (D6/D4/D10 are later).

**Storage**: PostgreSQL 16 (D2). Row-level security **enabled and forced**; application connects as
a non-owner role `app_user` with no bypass; migrations run as a separate owner/migrator role.

**Testing**: Vitest as the runner; `supertest` for HTTP contract tests (D12); **Testcontainers**
to spin up a real, ephemeral PostgreSQL for isolation/uniqueness tests (Constitution VIII — "a real
PostgreSQL instance"). No fake-AI server needed in this slice (no model calls).

**Target Platform**: Linux container; local developer run via `docker compose` (D18 names Cloud Run
+ Cloud SQL for prod, out of scope here).

**Project Type**: Backend web-service, structured as a **modular monolith** (D1). No frontend in this
slice (the staff screen is slice 004).

**Performance Goals**: Not a throughput slice. Operational target only: from a clean checkout, one
command brings the system to **ready in under 2 minutes** on a reference developer laptop (≥4 CPU
cores, ≥8 GB RAM) (SC-004); health and
readiness endpoints respond effectively instantly.

**Constraints**: No secret in any committed file (I7); all config from env with refuse-to-start
(FR-014); money as whole integer cents (I5/D8); shop identity derived only from the authenticated
credential, never from the request body/path (D2); module A never reads module B's tables and
imports only B's public entry file (D1, enforced by `dependency-cruiser`).

**Scale/Scope**: 3 shops in the scenario (`rb-downtown`, `rb-northside`, `rb-lakeshore`), designed
to hold more; 12 shared catalog services; a handful of HTTP endpoints (health, admin provisioning,
shop-scoped catalog/profile read). "Breaks first at 100 shops" analysis is deferred to slice 008.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution v1.1.0. Only the principles/invariants that bite in a foundation slice are gated here;
the rest are not exercised by this slice and are marked N/A with the slice that first exercises them.

| Principle / Invariant | Applies to 001? | How this plan satisfies it |
|---|---|---|
| I. Code owns money & decisions | Partial | No AI, no decisions, no side effects here. Catalog prices stored/served as **integer cents** (FR-017). Full rule first exercised in slice 003. |
| II. Invariants always hold (NON-NEGOTIABLE) | Yes (I1, I5, I7) | Each in-scope invariant gets a named test: I1 → cross-shop attack tests; I5 → whole-cent property/validation test; I7 → gitleaks + refuse-to-start test. I2/I3/I4/I6/I8 are out of scope for 001. |
| III. Database-enforced shop isolation (NON-NEGOTIABLE) | **Yes — core** | `tenant_id` (shop_id) on every shop-owned table; RLS **enabled and forced**; non-owner `app_user`; shop id from credential via per-tx `set_config('app.tenant_id', …, true)`; composite-key referencing convention; a build check fails if any `tenant_id` table lacks a forced policy (FR-004). |
| IV. Ports and adapters | Yes (boundaries) | Modular-monolith layout; `dependency-cruiser` rules established now (D1). No external adapters (AI/queue/email) exist yet, so none to wrap in this slice. |
| V. One-way & two-way doors | Yes | One-way doors decided here are already recorded: tenancy model (D2) and money format (D8). Reversible choices (test runner, migration tool, query lib, web framework) are named in this plan and kept behind the module structure. |
| VI. Failure is normal | Partial | No outgoing calls yet, so no timeouts/retries here. Covered facets: refuse-to-start on bad config, liveness/readiness. Durable-tracking / staff-review first exercised in slices 002–003. |
| VII. Privacy by default | Yes | No customer message text exists in this slice. Config from env; refuse-to-start when a required setting is missing (FR-014); no secret committed (FR-015/I7), verified by gitleaks in CI + pre-commit. |
| VIII. Tests prove the risky parts | Yes | Isolation + uniqueness tests run against **real PostgreSQL** (Testcontainers); whole-cent correctness via property/validation test; each risky-area test states why it exists. Real-model clause is N/A (no model in 001). |
| IX. Honesty about scope | Partial | README started this slice with the one-command run; full hours / not-built / "breaks first at 100 shops" is slice 008. No designed-but-unbuilt feature is claimed as built. |

**Gate result (pre-Phase 0): PASS.** No violations; Complexity Tracking left empty.

**Re-check (post-Phase 1 design): PASS.** The design adds no new dependency or pattern that
challenges a principle: isolation stays in the database (forced RLS + `app_user` + composite
convention, data-model.md); the admin/shop credential split preserves least-privilege (FR-020)
without a new trust boundary for the model (there is none in 001); all chosen libraries sit behind
`platform/*` or module `index.ts` (Principle IV); money stays integer cents (I5). The three in-scope
invariants each have a concrete test anchor (I1 → V5, I5 → V4, I7 → V2 in quickstart.md). No
later-slice capability leaked into the contracts or data model.

## Project Structure

### Documentation (this feature)

```text
specs/001-foundation/
├── plan.md              # This file (/speckit-plan)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (HTTP API contract)
│   └── openapi.yaml
├── checklists/
│   └── requirements.md  # from /speckit-specify + /speckit-clarify
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── api/
│   └── server.ts              # api process entrypoint (Express 5 bootstrap)
├── worker/
│   └── index.ts               # worker process entrypoint — placeholder; no jobs until slice 002
├── platform/                  # cross-cutting infrastructure (framework-thin)
│   ├── config/                # typed env settings (Zod); refuse-to-start on missing/empty (FR-014)
│   ├── db/                    # pg pool; migrator vs app_user roles; per-tx set_config tenant binding
│   ├── http/                  # typed-route helper (Zod), error handler, helmet, rate-limit, pino-http
│   └── observability/         # pino logger (JSON; no message text — none exists yet)
├── modules/                   # business modules; talk only via each module's public index.ts (D1)
│   ├── auth/                  # credential hashing/verify/revoke/last-used; admin vs shop auth
│   ├── shops/                 # shop entity + provisioning (admin)
│   ├── catalog/               # 12 services as versioned reference data; seed from committed JSON
│   └── health/                # liveness + readiness (reachable + migrations applied)
└── migrations/                # raw SQL (expand-and-contract): tables, tenant_id, forced RLS, roles

tests/
├── integration/               # real Postgres (Testcontainers): isolation attack (raw SQL as app_user), uniqueness, readiness
├── contract/                  # supertest: health, admin provisioning, shop-scoped catalog/profile
└── unit/                      # config refuse-to-start, whole-cent validation, credential hashing/last-used

# repository root
├── docker-compose.yml         # Postgres + api (+ worker placeholder) — the one-command local run (FR-012)
├── Makefile                   # make up / make down / make migrate / make test (documented single commands)
├── .dependency-cruiser.cjs    # module-boundary rules (D1, Principle IV)
├── .env.example               # every required setting listed; no real values (I7)
├── catalog/catalog.json       # committed authoritative catalog from the brief (FR-016)
└── .github/workflows/ci.yml   # strict tsc, lint, dependency-cruiser, unit + real-DB tests, gitleaks
```

**Structure Decision**: Single backend project laid out as a **modular monolith** (D1). Two process
entrypoints (`src/api`, `src/worker`) establish the api/worker split now; the worker is an inert
placeholder in this slice and gains behaviour in slice 002. Business logic lives under
`src/modules/*`, each exposing a public `index.ts`; cross-cutting infrastructure lives under
`src/platform/*`. `dependency-cruiser` forbids a module importing another module's internals or
reading another module's tables, and the api process must not import the (future) AI gateway.

## Complexity Tracking

> No constitution violations to justify. Section intentionally empty.
