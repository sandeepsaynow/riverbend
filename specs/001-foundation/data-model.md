# Phase 1 Data Model: 001-foundation

Derived from the spec's Key Entities and Functional Requirements, and the isolation rules in D2.
Types are described conceptually; exact DDL lives in `src/migrations/` at implementation time.
**Money is integer cents. Shop identity comes from the credential, never the request.**

## Roles (database)

Not entities, but part of the model because isolation depends on them (D2, Principle III):

- `riverbend_migrator` — owns the schema; runs migrations; **not** used to serve requests.
- `app_user` — the shop-request runtime role; **no `BYPASSRLS`, not a superuser**; every shop-owned
  table has RLS `ENABLE`d **and** `FORCE`d, with a policy that scopes it to
  `current_setting('app.tenant_id')`. This is the role the I1 attack test connects as.
- `app_admin` — the **restricted administrative** runtime role (connection `DATABASE_ADMIN_URL`),
  used **only** by the admin/auth module. Also **no `BYPASSRLS`, not a superuser** — it reaches
  across shops through an explicit *permissive policy on specific identity tables*, not a bypass.

The current shop is bound per transaction: `SELECT set_config('app.tenant_id', $shopId, true)`.
RLS policies compare `shop_id::text = current_setting('app.tenant_id', true)` (an unset tenant
matches nothing — fail-closed).

### Why `app_admin` exists, and how it stays restricted (D2 "API-key lookup" exception)

Two operations are inherently cross-shop and cannot run as the tenant-scoped `app_user`:
**authentication** must find a credential *by prefix before the shop is known* (no tenant to set
yet), and **provisioning** (create a shop, issue/revoke credentials) spans shops. Under forced RLS,
`app_user` cannot do either. `app_admin` is the least-privilege way to allow exactly those, and only
those.

Its access is **explicit and enumerated**, never blanket:

| Role | Table | Grants | Policy |
|---|---|---|---|
| `app_admin` | `shops` | SELECT, INSERT, UPDATE, DELETE | `shops_admin` permissive (`USING true`) |
| `app_admin` | `credentials` | SELECT, INSERT, UPDATE, DELETE | `credentials_admin` permissive (`USING true`) |
| `app_admin` | `catalog_service` | SELECT, INSERT, UPDATE, DELETE | none (shared reference data, no RLS) |
| `app_admin` | `pgmigrations` | SELECT | n/a |
| `app_user` | `shops` / `credentials` | SELECT, INSERT, UPDATE, DELETE | tenant-scoped (`= app.tenant_id`) |
| `app_user` | `catalog_service` / `pgmigrations` | SELECT | none / n/a |

**Confinement guarantee (verified):** `app_admin` has `rolsuper = false`, `rolbypassrls = false`,
`rolcreatedb = false`, `rolcreaterole = false`. It has **no default privileges on future tables** —
a new shop-owned table (e.g. `work_orders`) is *denied* to `app_admin` (SQLSTATE 42501) until a
migration explicitly grants it. Therefore **customer-content tables (messages, conversations, work
orders) MUST remain `app_user`/tenant-scoped only** in later slices and MUST NOT be granted to
`app_admin`; the admin path is for shop/credential identity data, not customer content. (These
tables do not exist in slice 001.)

## Entity: Shop (tenant)

The unit of tenancy. Owns all shop-scoped rows.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key; stable internal identity used by FKs. |
| `slug` | text | **Unique, immutable**, human-readable (e.g. `rb-downtown`); supplied at creation; `^[a-z0-9-]{3,40}$`. (FR-005) |
| `time_zone` | text | Named IANA zone (e.g. `America/Chicago`), set at creation; validated against the IANA set. (FR-006) |
| `display_name` | text | Optional human label; defaults to the slug. |
| `created_at` | timestamptz | Set on insert. |

- **Uniqueness**: `slug` globally unique; attempting a duplicate slug → rejected (edge case).
- **Composite anchor**: `UNIQUE (id, shop_id)` is not meaningful for the tenant row itself; instead
  `shops` exposes `id` as the value other shop-owned tables carry as `shop_id`. For shops, `shop_id`
  *is* `id` (a shop belongs to itself) so RLS on `shops` restricts a caller to its own row.
- **RLS**: enabled + forced; policy: `id = current_setting('app.tenant_id')::uuid`.
- **Lifecycle (001)**: create only. Deactivation/deletion is out of scope for this slice.

## Entity: Credential

Authenticates a caller. Two **kinds**; a shop may hold multiple active credentials (FR-007).

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key. |
| `kind` | enum(`shop`,`admin`) | `shop` → bound to one shop; `admin` → not shop-bound, provisions. (FR-020) |
| `shop_id` | UUID NULL | FK → `shops(id)`. **Required** when `kind='shop'`, **NULL** when `kind='admin'`. The `tenant_id` for RLS. |
| `prefix` | text | Public, indexed lookup handle (the part before the secret); unique. (D14) |
| `secret_fingerprint` | bytea | SHA-256 of the secret; the secret itself is never stored. (FR-008, D14) |
| `status` | enum(`active`,`revoked`) | Revoke is per-credential (FR-009). |
| `last_used_at` | timestamptz NULL | Updated on each successful authentication. (FR-010) |
| `created_at` | timestamptz | Set on insert. |
| `revoked_at` | timestamptz NULL | Set on revoke. |

- **Constraints**:
  - `CHECK ((kind = 'shop' AND shop_id IS NOT NULL) OR (kind = 'admin' AND shop_id IS NULL))`.
  - `prefix` unique; verification is prefix-lookup → constant-time compare of fingerprint (D14).
  - FK `shop_id → shops(id)`.
- **RLS**: `credentials` is a `tenant_id` table. Policy restricts `kind='shop'` rows to
  `shop_id = current_setting('app.tenant_id')`. `admin` rows (shop_id NULL) are **not** readable on
  the shop-scoped path at all; they are managed only via the admin path (which runs with a role/policy
  exception scoped to admin operations, not `app.tenant_id`). This keeps the I1 attack test meaningful:
  as `app_user` bound to shop A, a raw `SELECT * FROM credentials` returns only shop A's shop-credentials.
- **Lifecycle**: `active → revoked` (one-way). Issuance shows the secret exactly once (FR-008).

## Entity: Catalog Service (shared reference data)

Not shop-scoped (shared by all shops). Versioned so recorded prices never change meaning (FR-016/018).

| Field | Type | Notes |
|---|---|---|
| `catalog_version` | text | Deterministic version id `cat-NNN` (zero-padded monotonic integer; brief's catalog = `cat-001`), minted only when the committed catalog content changes. (FR-018) |
| `code` | text | Service code (from the brief's 12 services); **unique within a catalog version** (`UNIQUE (catalog_version, code)`). (FR-016) |
| `name` | text | Human name. |
| `price_cents` | integer | **Whole cents**; `CHECK (price_cents >= 0)`; non-integer input rejected at load. (FR-017, I5) |
| `minutes` | integer | Estimated duration. |
| `requires_inspection` | boolean | Stored only; estimate-inclusion behaviour is slice 004, not here. |

- **Source of truth**: `catalog/catalog.json` (committed, authoritative — the brief's catalog). A
  loader validates exactly **12** services against a Zod schema at seed time (whole-cent prices;
  `code` unique within the version) and writes them under the current `cat-NNN` version; a new version
  id is minted only when the committed content changes.
- **No RLS**: shared reference data; readable by any authenticated shop; not writable at runtime in 001.

## Entity: Schema Migration State (operational)

Backs readiness and the fail-closed startup gate (FR-013, FR-022, SC-008). Managed by the migration
tool.

| Field | Type | Notes |
|---|---|---|
| `name` / `run_on` | — | Applied-migrations ledger maintained by `node-pg-migrate`. |

- **Migrate-before-serve (FR-022)**: migrations are applied before the api serves traffic. If the
  required migrations are not applied, the schema is incompatible, or a required shop-isolation policy
  is absent, the system **fails startup** and serves no protected request.
- **Readiness (FR-013)** reports ready only when **all** hold: (a) data store reachable; (b) required
  migrations applied and schema compatible (exact required set present, none missing, no unknown/newer
  one applied); (c) required shop-isolation policies present and **forced** on every `tenant_id`
  table, verified at runtime via the database catalog (`pg_class.relforcerowsecurity` + `pg_policies`;
  complements the build-time FR-004 check). **Configuration is validated at startup (FR-014), not at
  readiness** — a running instance always has valid config. Liveness is independent (process-up only).

## Bootstrap administrative credential (operational, fail-closed)

Not a persisted entity on its own — a `kind='admin'` Credential provisioned at startup from
configuration (FR-021). Fail-closed rules:

- The initial admin credential comes from configuration (environment), validated at startup; its
  fingerprint is stored like any other credential (never the secret).
- **No default or hardcoded credential exists.** If the required credential configuration is missing
  or invalid, the system refuses to start and serves no protected (admin or shop) endpoint (FR-021,
  SC-009).

## Relationship summary

```text
Shop (1) ──< Credential (0..*)      [kind='shop'; shop_id = Shop.id; RLS-scoped]
Credential (kind='admin')           [shop_id NULL; not shop-scoped; admin path only]
Catalog Service (12, shared)        [no shop_id; versioned; read-only in 001]
```

## Invariant → model mapping (test anchors for /speckit-tasks)

| Invariant / FR | Enforced by | Proven by |
|---|---|---|
| I1 — no cross-shop read (FR-002/003) | forced RLS + `app_user` + composite convention | raw-SQL attack test as `app_user` (A cannot see B), + via-API (shop id from key, not params) |
| FR-004 — every tenant_id table has a policy | build/CI enumeration check | CI check fails on an unpoliced `tenant_id` table |
| Shop slug unique/immutable (FR-005) | `UNIQUE(slug)`, no update path | duplicate-slug rejected test |
| Multiple active creds + last-used (FR-007/010) | `credentials` schema | issue two keys → both authenticate; last_used_at updates |
| Individual revoke (FR-009) | `status` per row | revoke one → others still work |
| Admin ≠ shop (FR-020) | `kind` + route separation + CHECK | shop key on admin route → rejected; admin key on shop route → rejected |
| I5 — whole cents (FR-017) | `integer price_cents` + load validation | non-integer price rejected; property test |
| Code unique per version (FR-016) | `UNIQUE(catalog_version, code)` | duplicate code in a version rejected at load |
| Deterministic version (FR-018) | `cat-NNN` minted on content change | version is `cat-001` for the brief's catalog; stable across reseeds |
| Readiness = reachable + migrated/compatible + policies forced (FR-013) | 3-way runtime readiness check | unmigrated → `migrations_pending`; missing/unforced policy → `security_policy_missing`; unreachable → `db_unreachable` (config is a startup check, FR-014) |
| Migrate-before-serve / fail-closed (FR-022) | startup gate | incompatible/unpoliced schema → startup fails, no protected request served |
| No default credential; fail-closed (FR-021) | config-sourced bootstrap admin | missing/invalid admin config → refuses to start; no hardcoded credential |
| Auth on every protected route (FR-023) | shop/admin auth middleware | only /healthz,/readyz unauthenticated; all else 401 without a credential |
