# Feature 010 — Tasks (ordered; also the durable implementation checklist)

Status key: [x] done+verified · [~] scaffolded/not fully verified · [ ] not started.

> **Progress 2026-11-04 (implemented):** Slices A–D done + verified (123/123 tests, typecheck + lint
> clean). DONE: T001–T003 (install + config + generated schema migration), T010–T013 (membership/
> bootstrap, portal service, admin-init, session guard), T020–T021 (admin login/dashboard/staff
> list+create+disable), T030–T034 (staff login/logout/dashboard/requests/orders/needs-attention/usage),
> T040–T041 (own-route CSRF/Origin, disabled/revoked rejection, HttpOnly cookies, generic errors),
> T050–T053 (auth + authz + UI + regression tests on real PostgreSQL).
> **NOT run (honest): T054 — the real-AI browser smoke** (Compose + real OpenAI, clicking the UI) was
> not executed this session; the flows are proven by automated supertest+real-Postgres tests, not a
> browser. T004 (CLI re-verify) and polish (multi-shop selector UI, credential-replace UI) remain minor.
>
> **Update 2026-11-04 (final QA):** the Compose stack was booted with real services and the **live-AI
> HTTP E2E PASSED** — a Downtown request processed through **real OpenAI via LiteLLM** to an `ordered`
> work order with catalog prices ($110.00), and Northside could not see it (isolation). Portal/web-form/
> auth-gating were verified live over HTTP (`/admin/login` 200, `/staff`→302, `/v1` 401). The **literal
> browser click-through (T054) is still manual** (no browser automation was available) — exact steps in
> `docs/FINAL_MANUAL_TEST.md`. T054 remains unchecked: the API-level invariants pass, a human still clicks.
> **Install finding:** `npm i better-auth@1.7.16 --legacy-peer-deps` (unused @sveltejs/kit optional peer
> vs dev vite@5); pinned exact in package.json/lock.

## Phase 0 — Library + schema
- [ ] T001 Install `better-auth@1.7.16` + `@better-auth/cli@1.4.21` **with `--legacy-peer-deps`** (see
      finding above); pin in package-lock.
- [ ] T002 `src/platform/auth/better-auth.ts`: configure Better Auth (pg Pool adapter on a dedicated
      `auth` schema, `emailAndPassword` with signup disabled, `admin()` plugin, secret + baseURL +
      trustedOrigins, Secure cookies in prod).
- [ ] T003 Generate schema via `npx @better-auth/cli generate`; review; commit as
      `src/migrations/10000_better_auth.cjs` (CREATE SCHEMA auth; user/session/account/verification +
      admin fields). NOT under tenant RLS; grant to a restricted role.
- [ ] T004 Verify the generated DDL matches the installed version's expectations (CLI against the config).

## Phase 1 — Riverbend identity binding
- [x] T010 Migration `10000_staff_identity.cjs`: `shop_membership` + singleton `auth_bootstrap`, forced
      RLS + policies, FKs/unique/checks. Tested (tests/integration/staff-identity.test.ts). ✅ verified.
- [ ] T011 `AuthPortalService`: resolveMemberships(userId), activeMembership(userId, shopId),
      createStaff (allow-listed fields only), disableStaff, revokeSessions, replaceCredential.
- [ ] T012 Admin-init path (bootstrap-token-gated, atomic single-use via `auth_bootstrap`): create first
      PLATFORM_ADMIN via `auth.api.signUpEmail`/admin createUser + membership. Idempotent fail after init.
- [ ] T013 Session guard middleware (`auth.api.getSession`) + `requireStaff`/`requirePlatformAdmin` +
      membership→shopId resolver (never trust body shop_id).

## Phase 2 — Admin portal
- [ ] T020 `/admin/login` (email/password form → Better Auth sign-in) + `/admin` dashboard (3 shops).
- [ ] T021 `/admin/staff` list, `/admin/staff/new` (create via auth.api, shop+role), `/admin/staff/:id`
      (disable, revoke sessions, replace credential with reauth + audit). Mass-assignment prevented.

## Phase 3 — Staff portal (over existing services; escaped; catalog prices only)
- [ ] T030 `/staff/login` + `/staff/logout`.
- [ ] T031 `/staff` dashboard (recent requests, open orders, awaiting_customer, needs_review, held_budget).
- [ ] T032 `/staff/requests` + `/staff/requests/:id` (text, contact, extraction, state/errors,
      clarification Q/A, email metadata, work orders).
- [ ] T033 `/staff/orders` (itemized codes/qty/unit/total + inspection flags) ; `/staff/needs-attention`.
- [ ] T034 `/staff/usage` (LiteLLM team budget, proxy spend, recent costs, reset info, soft-cap note).

## Phase 4 — Security
- [ ] T040 CSRF/Origin on Riverbend's own state-changing HTML POSTs; verify Better Auth route protection.
- [ ] T041 Verify: login throttling, generic errors, disabled/revoked rejection, HttpOnly/SameSite/Secure.

## Phase 5 — Tests (real PostgreSQL)
- [ ] T050 Auth tests (init-once/concurrent, signup-disabled, create staff, dup email, hash-not-plaintext,
      correct-only auth, disabled/revoked rejected, throttle, CSRF/Origin).
- [ ] T051 Authz tests (shop binding, cross-shop rejected, admin vs staff, RLS intact, API-key intact).
- [ ] T052 UI tests (auth-gated, escaping, no secrets in HTML, correct order prices, needs-review visible,
      usage scoped).
- [ ] T053 Regression: full suite + 009 API-key tests + intake/email/pricing/budget + typecheck + lint.
- [ ] T054 Honest real-AI browser smoke (Compose + real OpenAI) per spec §11; report truthfully.

## Phase 6 — Docs + converge
- [ ] T060 Update constitution(if warranted)/REQUIREMENTS/ARCH_DECISIONS(D20)/EDGE_CASES/SLICES/PROGRESS/
      decision-log/README/.env.example + Feature 010 design doc; reconcile 001/004/005/006/009 notes.
- [ ] T061 Re-run analyze/converge; clean tree; commit locally (no push).
