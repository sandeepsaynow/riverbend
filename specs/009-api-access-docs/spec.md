# Feature 009 — Secure API access, OpenAPI docs, local ops (lean spec)

**Input**: Simplified 009 — an API-first multi-tenant MVP. **Not** human identity management: no
email/password, sessions, invitations, recovery, or a new RBAC user platform. Reuse the existing
shop-scoped **API-key** model and the platform `ADMIN_BOOTSTRAP_TOKEN`; add production-sensible
credential lifecycle, OpenAPI/Swagger, and a no-SQL local demo path.

## Already in place (001, verified — do not rebuild)
Crypto-secure keys (`rb_<kind>_<prefix>.<secret>`, 24-byte secret), **fingerprint-only** storage
(SHA-256), constant-time compare, one-time plaintext display, public `prefix` as the masked id,
shop-scoped + forced RLS, admin↔shop separation (401/403), fail-closed bootstrap admin. No secret is
retrievable after creation. LiteLLM virtual keys live in `shop_llm_identity` and are **never** returned
by any route.

## User stories
- **US1 (P1) Operator provisions keys safely.** Admin issues a shop key (optionally named, scoped, with
  an expiry), sees the plaintext **once**, and can **list** a shop's keys (masked), **revoke**, and
  **rotate** them. Every lifecycle event is **audit-logged**.
- **US2 (P1) Expiry + revocation are enforced.** An expired or revoked key authenticates as **401**.
- **US3 (P1) Discoverable API.** OpenAPI 3 + Swagger UI at `/docs` (local/non-prod) document every
  endpoint, the three credential kinds, idempotency, error shapes, tenant isolation, and budget states.
- **US4 (P2) No-SQL local demo.** One command initializes/reuses the three assignment shops and issues
  shop keys without manual SQL; existing keys are never silently rotated.

## Functional requirements
- **FR-001**: `credentials` gains `name`, `scopes text[]`, `expires_at` (nullable). Issuing accepts an
  optional name, scopes (default a read/intake set), and TTL days. **FR-002**: `authenticate()` rejects
  `status != active` OR `expires_at < now()` → 401.
- **FR-003**: `POST /admin/credentials/:id/rotate` issues a replacement for the same shop/scopes and
  revokes the old one; returns the new plaintext once. **FR-004**: `GET /admin/shops/:slug/credentials`
  lists that shop's credentials **masked** (id, kind, prefix, scopes, status, created/expires/last_used/
  revoked) — never a secret, never a LiteLLM key.
- **FR-005**: A `credential_audit` row is written on issue/revoke/rotate (credential id, shop, event, at)
  — ids only, no secrets (VII).
- **FR-006**: Scopes are carried on the principal; `requireScope()` gates sensitive reads
  (orders/needs-attention require `orders:read`). Existing keys default to the full read+intake scope
  set, so current behavior is unchanged.
- **FR-007**: `GET /openapi.json` + Swagger UI at `/docs`, enabled only when `NODE_ENV != production`
  (or `DOCS_ENABLED=true`); never exposes secrets, and the admin section is clearly labelled operator-only.
- **FR-008**: A local provisioning command (`make provision` / `scripts/provision.ts`) ensures the three
  shops exist and issues a shop key per shop, **idempotently** — it never rotates an existing key; if a
  shop already has an active key it reports that and issues a new one only with `--rotate`.
- **FR-009**: `ADMIN_BOOTSTRAP_TOKEN` stays a restricted platform-operator credential; its lifecycle +
  boundaries are documented. Existing admin endpoints are unchanged.

## Invariants touched
I1 isolation, I7 no committed secrets, VII privacy (audit logs ids-only). No change to I2–I6/I8.

## Acceptance (zero external deps)
Issue→list(masked, no secret)→authenticate ok→expire→401; revoke→401; rotate→old 401 + new ok; audit
rows for each event; scope enforcement (orders:read); `/openapi.json` covers every mounted route and
`/docs` serves Swagger UI (non-prod only); provisioning is idempotent and never silently rotates.

## Amendment (D31, 2026-11-06) — default shops auto-provisioned on boot

> Fresh deployments previously had **zero shops** until an operator ran `make provision`: `make up` applies
> migrations (schema + catalog) but migrations do not seed tenant rows. D31 fixes this.

- **FR-009 Auto-provision on boot.** The api, after migrations + the catalog seed, calls
  `provisionDefaultShops` (`src/modules/shops/provision.ts`) to ensure the three default shops
  (`rb-downtown`, `rb-northside`, `rb-lakeshore`) exist and own their inbound address `<slug>@<domain>`
  (`RESEND_INBOUND_DOMAIN`, falling back to `RESEND_REPLY_DOMAIN`). **Idempotent**: existing shops are reused
  (never duplicated, ids stable), no credentials are issued or rotated, and no orders/messages are modified —
  so it is safe on every boot, fresh or existing. Off with `AUTO_PROVISION_SHOPS=false`.
- **FR-010 Keys stay explicit.** `make provision` now only **issues one shop API key per shop** (shown once;
  never rotates an active key; `ROTATE=1` to replace). It reuses the same `provisionDefaultShops` helper for
  the shops+addresses, so CLI and boot-time provisioning never drift. Web-form and email intake work without
  a shop API key; only programmatic `/v1` access needs one.
- **Compatibility:** inbound-domain handling is unchanged for D31 routing — a shop-specific address stays
  authoritative; a missing domain leaves inbound addresses null (email-by-address off; generic content
  routing + web form unaffected). Verified by `tests/integration/provision-shops.test.ts`.
