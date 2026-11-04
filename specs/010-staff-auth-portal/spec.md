# Feature 010 — Staff auth + admin/staff browser portal (lean spec)

**Input**: Add **library-backed human authentication** (Better Auth) and a minimal server-rendered
operations portal, WITHOUT replacing the Feature 009 machine-to-machine shop API keys. Email/password
only; admin creates staff; no public signup, invitations, forced change, recovery, SSO, or JWT.

## Final product decisions (from the task; authoritative)
Better Auth owns authentication (password hashing/verify, sessions, login/logout, rate-limit); Riverbend
owns **authorization** (membership → shop → RLS). Three credential systems stay distinct: **Better Auth
user sessions** (browser), **shop API keys** (`/v1`), **LiteLLM virtual keys** (worker→proxy only, never
in the browser). Same identity architecture local and prod (only infra config differs).

## User stories
- **US1 (P1) First admin init (once).** An operator runs a bootstrap-token-gated, **single-use** init
  that creates the first PLATFORM_ADMIN via Better Auth; subsequent attempts fail.
- **US2 (P1) Admin manages staff.** Admin logs in (`/admin/login`), views the 3 shops, lists staff,
  **creates** staff (email, name, password, shop, role) via Better Auth's admin API, **disables** a
  staff account and **revokes** its sessions, and **replaces** a staff credential (reauth + audit).
- **US3 (P1) Staff login + scoped portal.** Staff log in (`/staff/login`) and see **only their shop's**
  dashboard, request detail, orders, needs-attention, and usage. A disabled staff/session is rejected.
- **US4 (P1) API keys untouched.** All Feature 009 `/v1` + `/admin` API-key behavior is preserved;
  browser auth never replaces it, and the two never silently fall back to each other.

## Functional requirements
- **FR-001 (library).** Better Auth `1.7.x` (MIT), **native `pg` Pool adapter** (no Prisma/Drizzle),
  email/password + `admin()` plugin. Its tables live in a dedicated **`auth` schema**, generated via the
  official CLI and committed as a **reviewed SQL migration** (no runtime schema mutation in prod). Public
  signup disabled.
- **FR-002 (mount).** The Better Auth handler is mounted on the Express 5 catch-all **before** any body
  parser, per its docs (`app.all('/api/auth/*splat', toNodeHandler(auth))`).
- **FR-003 (identity ≠ tenancy).** A `shop_membership(user_id, shop_id, role, status)` table (unique
  `(user_id, shop_id)`, FKs) binds a Better Auth user to shops/roles. Roles: `PLATFORM_ADMIN`,
  `SHOP_ADMIN`, `SHOP_STAFF`. Tenant for every protected read = session → user → **active** membership →
  shop → existing tenant-bound service → forced RLS. A client-supplied `shop_id` is never authorization.
- **FR-004 (admin init).** Bootstrap-token-gated, atomic single-use (an `auth_bootstrap` marker row);
  creates the admin via `auth.api` (never a hand-built password row). No default admin password.
- **FR-005 (staff mgmt).** Admin-only server routes wrap Better Auth admin APIs: create/disable/
  revoke-sessions/replace-credential. Mass-assignment of `role`/`shop_id`/admin status is prevented
  (explicit server-side allow-list). Staff cannot reach admin or escalate.
- **FR-006 (sessions/security).** HttpOnly + SameSite cookies; Secure + HTTPS in production (trusted
  proxy configured); CSRF/Origin validation on Better Auth routes and on Riverbend's own state-changing
  HTML routes; login throttling; generic auth errors (no user enumeration); logout; session expiry +
  revocation; disabled-user rejection. No secret in browser JS/localStorage.
- **FR-007 (UI).** Server-rendered pages: `/admin/login`, `/admin`, `/admin/staff[/new|/:id]`;
  `/staff/login`, `/staff/logout`, `/staff`, `/staff/requests[/:id]`, `/staff/orders`,
  `/staff/needs-attention`, `/staff/usage`. All customer-controlled content is HTML-escaped (no stored
  XSS); data comes from existing domain services (parameterized SQL); prices are code/catalog only
  (never recomputed by the LLM); no provider/LiteLLM/master secrets rendered.
- **FR-008 (API-key compatibility).** Feature 009 endpoints, issuance/rotation/revocation, Swagger, and
  tests remain intact. Routes accepting both a staff session and a shop API key define explicit
  precedence (none do in this MVP: `/v1` = API key, portal = session).

## Invariants touched
I1 isolation (membership-derived shop, forced RLS), I7 no committed secrets, VII privacy. Better Auth's
identity tables are global (NOT under tenant RLS) — a documented, deliberate boundary (its ops need
global reads); they carry no `shop_id`, so the isolation policy-check does not apply to them.

## Acceptance (automated, real PostgreSQL; browser smoke reported honestly, real-AI)
First-admin-once (concurrent bootstrap fails); signup disabled; admin creates staff; duplicate email
rejected; password never stored plaintext; correct password authenticates only its own user; disabled
user + revoked session rejected; staff bound to their shop; cross-shop read rejected; API-key path
unchanged; UI pages require auth, escape content, expose no secrets, show correct prices. Full prior
suite stays green.

## Explicitly NOT built (per decisions)
Public signup, invitations, forced first-login change, email verification, self-service recovery, SSO/
social, JWT, a separate identity microservice, a new frontend framework.

## Amendment (D20.1, 2026-11-04) — recoverable first-admin bootstrap (P0 fix)
The original bootstrap was not crash-safe (Better Auth user/account and the `auth_bootstrap` marker are
separate transactions; a crash between them left a marker that permanently blocked init with no usable
admin). Amended requirements:
- **FR-010a:** completion is the invariant `auth_bootstrap.admin_user_id IS NOT NULL`. A marker without it
  is PENDING and retryable; `isInitialized()` is false for a pending/failed marker.
- **FR-010b:** `auth_bootstrap` carries `admin_email` (binds a pending init to one email) and `status`
  (pending|completed). A retry against a pending marker with a *different* email is refused (`RecoveryRequired`).
- **FR-010c:** `initFirstAdmin` creates the admin or, on `USER_ALREADY_EXISTS` from a prior/concurrent
  attempt, reconciles to that user **after verifying it has a credential**, then records `admin_user_id`.
  Errors leave the marker PENDING (no delete) → safe retry; concurrency converges on one admin.
- **FR-010d:** a persistent credential-less orphan admin → `RecoveryRequired` (operator step), never
  auto-completed (`setUserPassword`/`removeUser` are UNAUTHORIZED without an admin session).
- **FR-011a (staff atomicity):** verify the shop before creating an identity; on duplicate email reconcile
  only an orphan identity (no membership) — never attach a real account to a new shop; membership upsert is
  idempotent (`unique(user_id, shop_id)`).

## Amendment (D20.2, 2026-11-04) — security re-audit (supersedes D20.1 reconcile-by-email)
- **FR-010e (ownership proof):** bootstrap completes only with an `admin_user_id` that the bootstrap flow
  itself created and recorded. An email-matched pre-existing account is **never** adopted; an existing-email
  with no recorded id fails closed (`RecoveryRequired`) after a brief concurrent-winner wait. Enforced by a
  DB CHECK (`status='completed' ⇒ admin_user_id IS NOT NULL`, migration 12100).
- **FR-011b (staff never adopts):** `createStaff` never attaches a membership to a pre-existing account — a
  duplicate email fails closed (`email already in use`); the platform admin (no membership) can never be
  granted a shop membership this way. Shop verified before any identity is created.
- **FR-012 (CSRF full-origin):** state-changing portal POSTs validate the full `scheme://host:port` Origin
  (Referer fallback; missing allowed for same-origin forms) against an exact allowlist — prod = one HTTPS
  origin; dev = that origin + its loopback sibling. Foreign/scheme/port/null are rejected; CSRF is never disabled.
- **Prod gap (documented):** Better Auth runtime uses the migrator DB role; a dedicated restricted role is
  the production recommendation.
