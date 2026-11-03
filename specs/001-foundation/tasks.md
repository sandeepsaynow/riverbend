---
description: "Task list for 001-foundation implementation"
---

# Tasks: Foundation — Shops, Credentials & Isolation

**Input**: Design documents from `specs/001-foundation/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml),
[quickstart.md](./quickstart.md)

**Tests**: REQUIRED. The constitution (Principle VIII, and the slice loop's "every invariant has a
test task") mandates tests for the risky areas; isolation/uniqueness tests run against a **real
PostgreSQL** (Testcontainers). No fake-AI server is needed (no model in this slice).

**Organization**: Tasks are grouped by user story. Stories are independently testable; US1 can be
exercised by seeding the database directly, so it does not depend on US2's provisioning API.

**Paths** follow the structure in [plan.md](./plan.md) (modular monolith: `src/platform/*`,
`src/modules/*`, `src/migrations/`, `tests/*`).

## Scope guard (do not build ahead)

- FR-019: **no AI/model processing** anywhere. The `worker` process is an inert placeholder until
  slice 002 (T017). No intake/202/queue, work orders, web form, email, or retries belong here.

---

## Phase 1: Setup (project initialization)

- [x] T001 Initialize Node 22 / TypeScript 5 project with strict `tsconfig.json` and `package.json` scripts at repo root
- [x] T002 [P] Add runtime dependencies (`express@5`, `zod`, `helmet`, `express-rate-limit`, `pino`, `pino-http`, `pg`) to `package.json`
- [x] T003 [P] Add dev dependencies (`typescript`, `vitest`, `supertest`, `@testcontainers/postgresql`, `node-pg-migrate`, `dependency-cruiser`) to `package.json`
- [x] T004 [P] Create `docker-compose.yml` (PostgreSQL 16 + api service) at repo root for the one-command local run
- [x] T005 [P] Create `Makefile` with `up` / `down` / `migrate` / `test` targets at repo root
- [x] T006 [P] Create `.env.example` listing every required setting with no values at repo root
- [x] T007 [P] Add a schema-valid catalog fixture at `catalog/catalog.json` mirroring the brief's shape (12 services; replaced with the authoritative file in T056)
- [x] T008 [P] Create `.dependency-cruiser.cjs` with module-boundary rules (D1, Principle IV) at repo root
- [x] T009 [P] Scaffold `.github/workflows/ci.yml` (strict `tsc`, lint, dependency-cruiser, unit + real-DB tests, gitleaks)

---

## Phase 2: Foundational (blocking prerequisites — MUST complete before user stories)

**Purpose**: shared infrastructure every story depends on. No story label.

- [x] T010 Typed environment config loader with **refuse-to-start** on a missing/empty setting (Zod; names the setting) in `src/platform/config/index.ts` (FR-014 core; completed in US4)
- [x] T011 DB connection pool + separate `riverbend_migrator` and non-owner `app_user` roles + per-transaction `set_config('app.tenant_id', $1, true)` helper in `src/platform/db/index.ts`
- [x] T012 Migration runner (`node-pg-migrate`) wrapper and a **migrate-before-serve** gate hook in `src/platform/db/migrate.ts`
- [x] T013 [P] Express 5 app skeleton with central error handler, `helmet`, `express-rate-limit`, and `pino-http` in `src/platform/http/app.ts`
- [x] T014 [P] Typed-route helper (Zod request/response; CI fails if a route lacks schemas) in `src/platform/http/typed-route.ts`
- [x] T015 [P] Structured pino JSON logger that never logs message text in `src/platform/observability/logger.ts`
- [x] T016 api process entrypoint wiring config → db → migrate-before-serve gate → http in `src/api/server.ts`
- [x] T017 [P] Inert `worker` process placeholder (no jobs until slice 002; documented as such) in `src/worker/index.ts`

---

## Phase 3: User Story 1 — A shop's data is never visible to another shop (Priority: P1) 🎯

**Goal**: Database-enforced shop isolation (invariant I1).

**Independent test**: Seed two shops + rows directly; as `app_user` bound to shop A, every raw-SQL
read/update/delete of shop B's rows returns nothing / no effect, and no API parameter can override
the credential's shop. The policy build-check fails if any `tenant_id` table lacks a forced policy.

- [x] T018 [P] [US1] Migration: `shops` table — `id` UUID PK, `slug` text **UNIQUE, immutable, `^[a-z0-9-]{3,40}$`**, `time_zone` text (named IANA), `display_name` text, `created_at` timestamptz — in `src/migrations/`
- [x] T019 [US1] Migration: `credentials` table — `id` UUID PK, `kind` enum(`shop`,`admin`), `shop_id` UUID **NULL** with `CHECK ((kind='shop' AND shop_id IS NOT NULL) OR (kind='admin' AND shop_id IS NULL))`, `prefix` text UNIQUE, `secret_fingerprint` bytea, `status` enum(`active`,`revoked`), `last_used_at` timestamptz NULL, `created_at`/`revoked_at` — FK `shop_id → shops(id)` — in `src/migrations/`
- [x] T020 [US1] Migration: `ENABLE` **and** `FORCE` row-level security on `shops` and `credentials` with policies `… = current_setting('app.tenant_id')::uuid` (admin rows, `shop_id IS NULL`, not visible on the shop-scoped path) in `src/migrations/`
- [x] T021 [US1] Migration: grant `app_user` (no `BYPASSRLS`) runtime privileges; migrations owned by `riverbend_migrator` in `src/migrations/`
- [x] T022 [P] [US1] Policy build-check (FR-004): enumerate `tenant_id` tables and fail when any lacks a forced RLS policy, in `src/platform/db/policy-check.ts`; wire into CI
- [x] T023 [US1] Per-request tenant context: derive shop id **only** from the authenticated credential and bind it via `set_config`; ignore any shop id in body/path (FR-001) in `src/platform/http/tenant-context.ts`
- [x] T024 [P] [US1] Integration test (Testcontainers, real PG): as `app_user` bound to shop A, cross-shop read/update/delete of shop B rows returns nothing / no effect — **I1** (SC-001) in `tests/integration/isolation.attack.test.ts`
- [x] T025 [P] [US1] Integration test: via-API, shop A's credential cannot reach shop B by any parameter (identity comes from the key) in `tests/integration/isolation.api.test.ts`
- [x] T026 [P] [US1] Test: the FR-004 policy build-check fails on an intentionally unpoliced `tenant_id` table in `tests/integration/policy-check.test.ts`

**Checkpoint**: Isolation is provable end-to-end against a real database.

---

## Phase 4: User Story 2 — Provision a shop and issue a revocable credential (Priority: P1)

**Goal**: Admin-only provisioning; hashed, revocable, multi-active credentials with last-used;
fail-closed bootstrap.

**Independent test**: Create a shop, issue a credential shown once, authenticate with it, confirm the
raw secret is unretrievable, issue a second, revoke one and confirm the other still works; confirm a
shop key is rejected on admin routes and vice-versa; confirm a missing bootstrap credential fails closed.

- [x] T027 [P] [US2] Credential helper: token format `rb_<kind>_<prefix>.<secret>`, store **prefix + SHA-256 fingerprint** only, verify by prefix-lookup then **constant-time compare** (D14) in `src/modules/auth/credential.ts`
- [x] T028 [US2] Authentication: resolve credential, update `last_used_at` on success, reject missing/unknown/malformed/revoked (FR-010/FR-011) in `src/modules/auth/verify.ts`
- [x] T029 [US2] Shop-auth and admin-auth middleware with cross-kind rejection — shop key on admin route → 403, admin key on shop route → 403 (FR-020/FR-023) in `src/modules/auth/middleware.ts`
- [x] T030 [US2] Fail-closed bootstrap: provision the initial `admin` credential from configuration, validate at startup, **no default/hardcoded credential**, refuse to start + serve no protected endpoint if missing/invalid (FR-021) in `src/modules/auth/bootstrap.ts`
- [x] T031 [US2] Shops provisioning service: create shop with unique immutable slug + validated IANA `time_zone`; reject duplicate slug (FR-005/FR-006) in `src/modules/shops/index.ts`
- [x] T032 [US2] Admin endpoints `POST /admin/shops`, `POST /admin/shops/{slug}/credentials` (secret returned **exactly once**, FR-008), `POST /admin/credentials/{id}/revoke` (individual revoke, FR-009) per contract in `src/modules/shops/routes.ts` and `src/modules/auth/routes.ts`
- [x] T033 [P] [US2] Shop endpoint `GET /v1/shop` returning only the caller's own shop (FR-001) in `src/modules/shops/routes.ts`
- [x] T034 [P] [US2] Contract tests (supertest): admin create/issue/revoke happy paths; shop-key-on-admin → 403; admin-key-on-shop → 403 (FR-020/FR-023) in `tests/contract/admin.test.ts`
- [x] T035 [P] [US2] Integration test: credential shown once and not retrievable; two active keys both authenticate; revoking one leaves the other working; `last_used_at` updates (FR-007/008/009/010, SC-002/003) in `tests/integration/credential.lifecycle.test.ts`
- [x] T036 [P] [US2] Integration test: duplicate slug rejected; slug immutable (FR-005) in `tests/integration/shop.create.test.ts`
- [x] T037 [P] [US2] Integration test: missing/invalid bootstrap admin credential → fail closed, no protected endpoint served (FR-021, SC-009) in `tests/integration/bootstrap.failclosed.test.ts`

**Checkpoint**: Shops and credentials can be provisioned safely; US1 + US2 is the first genuinely useful increment.

---

## Phase 5: User Story 3 — Run the whole system with one command, with health signals (Priority: P2)

**Goal**: One-command run; independent liveness; four-check readiness; migrate-before-serve/fail-closed.

**Independent test**: `make up` reaches ready < 2 min and `make down` is clean; `/healthz` stays alive
while `/readyz` turns not-ready (with reasons) for each failing check; startup fails on an
incompatible/unpoliced schema.

- [x] T038 [US3] `GET /healthz` liveness (process-up only; independent of readiness) in `src/modules/health/routes.ts`
- [x] T039 [US3] `GET /readyz` readiness with **three** checks (reachable; migrations applied/schema compatible; shop-isolation policies present and **forced**, verified at runtime via `pg_class.relforcerowsecurity` + `pg_policies`) → machine-readable `reasons` (`db_unreachable`, `migrations_pending`, `schema_incompatible`, `security_policy_missing`) per contract (FR-013). Configuration validity is a startup check (FR-014), not a readiness reason. In `src/modules/health/readiness.ts`
- [x] T040 [US3] Enforce migrate-before-serve and fail startup on incompatible/unpoliced schema (FR-022) in `src/api/server.ts`
- [x] T041 [US3] Wire `docker-compose.yml` + `Makefile` so `make up` migrates, seeds, and reaches ready in under 2 minutes; `make down` tears down cleanly (SC-004)
- [x] T042 [P] [US3] Contract test: `/healthz` alive; `/readyz` ready vs 503 `NotReady` shapes per `contracts/openapi.yaml` in `tests/contract/health.test.ts`
- [x] T043 [P] [US3] Integration tests: db down → `db_unreachable`; unmigrated → `migrations_pending`; a `tenant_id` table missing/without a forced policy → `security_policy_missing`; liveness stays alive throughout (FR-013, SC-008) in `tests/integration/readiness.test.ts` (invalid-config → refuse-to-start is covered by T048, not readiness)
- [x] T044 [P] [US3] Integration test: startup fails and serves no protected request on an incompatible/unpoliced schema (FR-022) in `tests/integration/migrate-before-serve.test.ts`

**Checkpoint**: The system runs from one command and reports health honestly.

---

## Phase 6: User Story 4 — Fail fast on misconfiguration; never commit a secret (Priority: P2)

**Goal**: Complete required-settings validation + refuse-to-start; zero committed secrets.

**Independent test**: Removing/emptying a required setting aborts start naming it; a secret scan finds nothing.

- [x] T045 [US4] Finalize the required-settings schema and refuse-to-start behaviour (names the missing/empty setting; treats empty as missing) in `src/platform/config/index.ts` (FR-014)
- [x] T046 [P] [US4] Complete `.env.example` with every required key and no values at repo root (I7)
- [x] T047 [P] [US4] Add `.gitleaks.toml` + a pre-commit hook + the CI gitleaks job (FR-015/I7)
- [x] T048 [P] [US4] Unit test: a missing **and** an empty required setting each cause refuse-to-start naming the setting (SC-005) in `tests/unit/config.test.ts`
- [x] T049 [P] [US4] CI check / test asserting the secret scan reports zero committed secrets (SC-006) in `.github/workflows/ci.yml`

**Checkpoint**: Misconfiguration fails loud; no secret can be committed.

---

## Phase 7: User Story 5 — A shared, versioned service catalog (Priority: P3)

**Goal**: 12 shared services as versioned reference data; whole cents; codes unique per version.

**Independent test**: Each shop reads the identical 12 services with whole-cent prices and a `cat-NNN`
version; non-whole-cent and duplicate-code inputs are rejected at load.

- [x] T050 [US5] Catalog loader: validate `catalog/catalog.json` (exactly **12** services; each with `code`, `name`, integer `price_cents`, `minutes`, `requires_inspection`; **`code` unique within a version**; non-whole-cent rejected) and assign a deterministic `cat-NNN` version (brief's catalog = `cat-001`) in `src/modules/catalog/loader.ts` (FR-016/017/018)
- [x] T051 [US5] Migration + seed: catalog as versioned shared reference data with `UNIQUE (catalog_version, code)` and integer `price_cents` (no RLS; shared) in `src/migrations/`
- [x] T052 [P] [US5] `GET /v1/catalog` returning `{catalog_version, services:[12]}` to any authenticated shop per contract in `src/modules/catalog/routes.ts`
- [x] T053 [P] [US5] Integration tests: exactly 12 services; non-whole-cent rejected (**I5**); duplicate code rejected; identical across two shops; version present (SC-007) in `tests/integration/catalog.test.ts`

**Checkpoint**: The catalog is reproducible, versioned, and identical for every shop.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T054 [P] Route-schema contract check: CI fails if any route lacks Zod request/response schemas (D12) in `tests/contract/route-schema.test.ts`
- [x] T055 [P] `README.md`: one-command run, required settings, time-zone documentation (Q-TZ default + chosen zone), and a pointer to the eventual not-built list
- [x] T056 Replace the catalog fixture with the brief's **authoritative** `catalog/catalog.json` (input dependency from research R8) — DONE 2026-11-03: extracted verbatim from the brief PDF (12 services; codes/prices/minutes/requires_inspection unchanged); only our internal `catalog_version: cat-001` added. Loader + seed tests pass.
- [x] T057 [P] Finalize `.github/workflows/ci.yml` so strict `tsc` + lint + dependency-cruiser + unit + real-DB tests + gitleaks all run and gate merge
- [x] T058 Verify 001 constitution gates: I1 (T024/T025), I5 (T053), I7 (T048/T049) each have a passing named test, and confirm no later-slice capability is present (FR-019)

---

## Dependencies & completion order

- **Setup (Phase 1)** → **Foundational (Phase 2)** block everything.
- **US1 (Phase 3)** depends only on Foundational. It is the headline guarantee and the MVP.
- **US2 (Phase 4)** depends on Foundational + the `shops`/`credentials` schema from US1 (T018–T021).
- **US3 (Phase 5)** depends on Foundational (T010–T012, T016) and reads the policy/migration state from US1.
- **US4 (Phase 6)** depends on the config loader (T010); otherwise independent.
- **US5 (Phase 7)** depends on Foundational + the committed catalog file (T007/T056); independent of US1/US2 logic.
- **Polish (Phase 8)** depends on all stories; T056 (real catalog) can land any time after T007.

Story independence: US1 is testable via direct DB seeding (no US2 API needed). US3/US4/US5 do not
depend on each other.

## Parallel execution examples

- **Setup**: T002–T009 are all `[P]` (distinct files) — run together after T001.
- **Foundational**: T013, T014, T015, T017 `[P]` after T010–T012, T016.
- **US1 tests**: T024, T025, T026 `[P]` once T018–T023 land.
- **US2**: T027 and T033 `[P]`; the test tasks T034–T037 `[P]` once endpoints exist.
- **US3 tests**: T042, T043, T044 `[P]`. **US5**: T052, T053 `[P]` after T050/T051.

## Implementation strategy (MVP first, incremental)

1. **MVP = Phase 1 + 2 + US1**: a runnable base that **proves shop isolation** (I1) against a real
   database — the single most important guarantee and half the evaluation weight.
2. **First useful increment = + US2**: provision shops and revocable credentials safely (fail-closed).
3. **Operable increment = + US3 + US4**: one-command run, honest health, fail-fast config, no secrets.
4. **Complete the slice = + US5 + Polish**: versioned catalog, README, full CI, drop in the real catalog.
5. Every slice boundary ends with a running system and passing tests (Constitution IX / slice loop).

## Requirement → task coverage (every FR has a task; every in-scope invariant has a test)

| FR / Invariant | Task(s) |
|---|---|
| FR-001 | T023, T029, T033 |
| FR-002 / FR-003 / **I1** | T020, T024, T025 |
| FR-004 | T022, T026 |
| FR-005 / FR-006 | T018, T031, T036 |
| FR-007 / FR-008 / FR-009 / FR-010 | T027, T028, T032, T035 |
| FR-011 | T028, T034 |
| FR-012 | T041 |
| FR-013 | T038, T039, T042, T043 |
| FR-014 | T010, T045, T048 |
| FR-015 / **I7** | T046, T047, T048, T049 |
| FR-016 / FR-017 / FR-018 / **I5** | T050, T051, T053 |
| FR-019 | T017, T058 (scope guard) |
| FR-020 | T029, T030, T032, T034 |
| FR-021 | T030, T037 |
| FR-022 | T040, T044 |
| FR-023 | T029, T034 |

---

## Phase 9: Convergence

Appended by `/speckit-converge` (2026-11-03). Findings are drift between the implementation and the
approved artifacts/constitution. None are CRITICAL/HIGH; all are doc/strictness/coverage polish.

- [x] T059 Document the restricted administrative path (role `app_admin` + `DATABASE_ADMIN_URL`) in `specs/001-foundation/data-model.md` and `docs/ARCHITECTURE_DECISIONS.md`: why it exists, its exact grants, NOBYPASSRLS/non-superuser, permissive policy only on identity tables (shops, credentials), and that it MUST NOT be granted on customer-content tables (messages, conversations, work orders) in later slices per plan/D2 (partial) — DONE 2026-11-03: data-model.md Roles section + grant/policy table added; D2 refinement note added; verified live (rolsuper=false, rolbypassrls=false; app_admin denied 42501 on an ungranted tenant table).
- [x] T060 Restore `exactOptionalPropertyTypes: true` in `tsconfig.json` with two small type corrections — `src/modules/shops/routes.ts` (pass `displayName` only when present) and `src/platform/observability/logger.ts` (`base: null` not `undefined`) per plan: strict TypeScript (partial) — DONE 2026-11-03: flag restored; both fixes applied; `tsc` clean; 27/27 tests pass.
- [x] T061 Add a readiness-path assertion for the `schema_incompatible` reason in `tests/integration/readiness.test.ts` per FR-013 / SC-008 (partial, from analyze finding C1) — NO CHANGE NEEDED 2026-11-03: already covered at readiness.test.ts:52–60 (calls checkReadiness, asserts reasons contains `schema_incompatible`); analyze C1 was stale.
