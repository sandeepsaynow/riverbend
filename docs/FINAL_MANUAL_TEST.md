# Riverbend — Final Manual Test Guide (submission walkthrough)

Written for a reviewer doing a hands-on acceptance pass. Every command and route below is taken from the
actual code (compose, `scripts/provision.ts`, `src/api/*routes*`, `src/modules/portal`). Ports are the
ones the compose file publishes. The automated suite (`npx vitest run`, **138/138** on real PostgreSQL)
already proves these flows deterministically; this guide is for the live, in-browser confirmation
(Feature 010 **T054**) and the live-AI/email paths.

> **The three things that bite you locally, and the one-file fix.** The committed `docker-compose.yml` is
> production-like: it publishes Postgres on host `5432` (collides with a host-native Postgres — the known
> `localhost:5432` conflict), runs `NODE_ENV=production` (Better Auth sets **Secure-only** cookies, which a
> browser will not keep over plain `http://localhost`, so portal login silently fails), and disables
> Swagger in prod. The committed **`docker-compose.local.yml`** overlay fixes all three for local testing
> (db not published, `NODE_ENV=development`, `DOCS_ENABLED=1`). Use it for the browser walkthrough.

---

## 1. Start the application

Live-AI acceptance (real OpenAI via LiteLLM), browser-ready:

```bash
cd <repo>/app
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm up -d --build
```

Without the `llm` profile the worker falls back to the deterministic FakeGateway (no OpenAI); include
`--profile llm` for the real-AI test. To keep the production-like published db port instead of the overlay,
set a non-conflicting host port: `DB_HOST_PORT=55432 docker compose --profile llm up -d --build`.

## 2. Required `.env` values (names only — never commit real secrets; `.env` is git-ignored)

| Variable | Needed for | Notes |
|---|---|---|
| `ADMIN_BOOTSTRAP_TOKEN` | first-admin init | any strong string |
| `BETTER_AUTH_SECRET` (+ `BETTER_AUTH_URL`) | admin/staff portal | portal is OFF without it |
| `WEB_FORM_SIGNING_KEY` | public `/f/<shop>` form | form is OFF without it |
| `OPENAI_API_KEY` + `LITELLM_MASTER_KEY` | live AI extraction | injected into the `litellm` service only |
| `EMAIL_SIGNING_KEY` | reply-token correlation | email is OFF without it |
| `RESEND_API_KEY` (+ `RESEND_FROM`, `RESEND_REPLY_DOMAIN`) | real outbound + inbound polling | must be a live `re_…` key |
| `RESEND_WEBHOOK_SECRET` | OPTIONAL push webhook | not needed in polling mode |

Verify presence without printing values: `grep -oE '^[A-Z_]+=' .env | sort`.

## 3. Check the containers

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm ps
curl -s http://localhost:8080/readyz     # → {"status":"ready"}
curl -s http://localhost:8080/healthz    # → 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/health/liveliness   # LiteLLM → 200
```

Expected `ps`: `db` healthy, `api` up, `worker` up, `litellm` healthy. API log should show
`staff portal enabled`, `public web form enabled`, `inbound ... polling enabled` (worker) and `api listening`.

## 4. Seed the three shops + API keys (in-container — avoids the host DB entirely)

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml exec api npx tsx scripts/provision.ts
```

Prints 3 shops — `rb-downtown`, `rb-northside`, `rb-lakeshore` — each with a one-time
`Authorization: Bearer rb_shop_…` key. Copy the keys you want for the API checks (step 10/13).
Re-run with `-- --rotate` to replace keys.

## 5. Initialize the first admin (single-use; bootstrap-token-gated)

```bash
curl -s -X POST http://localhost:8080/admin/init \
  -H 'content-type: application/json' \
  -d '{"bootstrap_token":"<ADMIN_BOOTSTRAP_TOKEN>","email":"admin@riverbend.test","password":"Admin-Password-123","name":"Admin"}'
```

Expected: `201`. A second call returns `409` (single-use). A call without the token returns `401`.

## 6. Admin login (browser)

Open **http://localhost:8080/admin/login** → sign in with the admin email/password from step 5 →
redirected to **/admin** (dashboard lists the 3 shops).

## 7. Create staff (browser, as admin)

From **/admin/staff** → "new": create two staff, each bound to one shop:
- `staff-dt@riverbend.test` → shop `rb-downtown`, role `SHOP_STAFF`
- `staff-ns@riverbend.test` → shop `rb-northside`, role `SHOP_STAFF`

(The shop id for each is shown on the admin dashboard / staff form.)

## 8. Staff login (browser)

Open **http://localhost:8080/staff/login** → sign in as `staff-dt@riverbend.test`.

## 9. Customer form (browser)

Open **http://localhost:8080/f/rb-downtown** (also `/f/rb-northside`, `/f/rb-lakeshore`). Fill the email
field (required) and the message, submit. You get a status page; a browser refresh re-submits idempotently
(same request, not a duplicate).

### Three suggested test messages
1. **Simple & clear:** `My road bike chain is worn and skipping; please replace the chain and do a basic tune-up.`
   → extracts two catalog services, creates an **ordered** work order (observed live: CHAIN_REPLACE $45.00 +
   TUNE_BASIC $65.00 = **$110.00**).
2. **Multiple bikes/services:** `Two bikes: my commuter needs new brake pads and a flat tire fixed, and my kid's bike needs a tune-up.`
   → multiple bikes / multiple line items, catalog-priced.
3. **Ambiguous (needs clarification):** `My bike makes a weird noise sometimes, can you look at it?`
   → pipeline asks **one** clarification question → request parks `awaiting_customer` → a clarification
   email is queued (see step 13).

## 10. Inspect requests and orders

- Browser (staff): **/staff/requests**, **/staff/requests/:id**, **/staff/orders**, **/staff/needs-attention**.
- API (shop key from step 4):
  ```bash
  curl -s http://localhost:8080/v1/orders -H "Authorization: Bearer <downtown key>"
  curl -s http://localhost:8080/v1/requests/<request_id> -H "Authorization: Bearer <downtown key>"
  ```
  Orders show `unit_price_cents`/`line_total_cents`/`order_total_cents` + `catalog_version` — **catalog
  prices only** (the model never prices).

## 11. Inspect LiteLLM spending

- Browser (staff): **/staff/usage** — team budget, proxy spend, recent costs, reset info (D21 soft cap).
- Or the proxy directly (operator): `curl -s -H "Authorization: Bearer <LITELLM_MASTER_KEY>" http://127.0.0.1:4000/spend/logs`.

## 12. Verify tenant isolation

Log in as `staff-ns@riverbend.test` (Northside) in a second browser/profile: **/staff/orders** must NOT
show Downtown's order. Forcing another shop via a query string is ignored. API equivalent (observed live):
`GET /v1/orders` with the Northside key returns `{"orders":[],"shop_total_cents":0}` while Downtown's key
returns the $110.00 order.

## 13. Real Resend outbound (within account restrictions)

With a **valid** `RESEND_API_KEY` and `RESEND_FROM='…<onboarding@resend.dev>'`: before you verify a sending
domain, Resend only delivers to **your own account email**. So submit an **ambiguous** request (step 9, msg
3) whose customer email is *your own account email*; the worker sends the one clarification via Resend.
Confirm in the Resend dashboard (Emails) and in `email_outbox` (`status='sent'`, a `provider_message_id`).
This is **real outbound acceptance (B)** — not full customer delivery (D), which needs domain verification.

## 14. Verify inbound replies

**Default = polling (no webhook/URL/tunnel).** Reply from any mailbox to the
`reply+<token>@<RESEND_REPLY_DOMAIN>` address (a Resend-managed `<id>.resend.app` receiving domain). Within
`RESEND_POLL_INTERVAL_SECONDS` (default 60) the worker lists it, fetches content, correlates, and resumes
the request. Watch: `docker compose ... logs worker | grep -iE 'poll|email'`. The request moves off
`awaiting_customer` and the staff console shows the reply. **Optional webhook mode:** set
`RESEND_WEBHOOK_SECRET` + a dashboard webhook to `POST <public-url>/webhooks/resend` (lower latency).

## 15. Identify failure from logs

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm logs api      | tail -50
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm logs worker   | tail -50
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile llm logs litellm  | tail -50
```

Signals: `resend inbound poll failed` → invalid `RESEND_API_KEY`; request `needs_review` with
`email_delivery_failed`/`no_reply_path` → send problem; a worker `relation ... does not exist` at first
boot self-heals (the api migrates first; the worker restarts). Logs carry **ids only** — never email bodies
or secrets.

## 16. Expected results (summary)

| Step | Expected |
|---|---|
| readyz/healthz | `{"status":"ready"}` / 200 |
| provision | 3 shops + 3 keys |
| /admin/init | 201 (then 409 on repeat) |
| admin/staff login | 302 → dashboard; session persists (dev overlay) |
| customer form (clear) | request `ordered`, catalog-priced order |
| customer form (ambiguous) | `awaiting_customer` + one clarification email |
| isolation | Northside cannot see Downtown orders |
| /staff/usage | LiteLLM budget + spend visible |

## Live Resend validation (observed 2026-11-04, real key in `.env`)

- **API key:** valid — `GET /emails/receiving` → **200**.
- **Receiving API:** **PASS** — list returns the account's emails at the managed domain
  `karoiechou.resend.app`; `receiving.get` response schema matches the app's `ReceivedEmail` mapping.
- **Polling worker:** **PASS** — the live worker discovered a real received email, fetched its content, and
  correctly **ignored** it (not a `reply+token` address); checkpoint advanced, lease released.
- **Outbound provider API:** **PASS** — a send to `delivered@resend.dev` returned **200** + a real id.
- **Real Riverbend clarification:** **PASS** (after the D21.2 token fix) — an ambiguous request → real
  OpenAI question → `awaiting_customer` → Resend send → `email_outbox` `sent` with a persisted provider id.
  (Before the fix it was **422** because the `reply+<token>@` local part was 142 chars > RFC's 64; the token
  is now a compact 62-char local part.)
- **Full customer reply (D):** **BLOCKED-pending-you** — reply from a real mailbox to the
  `reply+<token>@karoiechou.resend.app` address of a live awaiting request (step 14). `delivered@resend.dev`
  does not reply, so the resumption half can't be driven automatically; the discovery/correlation mechanics
  are proven.

## 17. Known limitations to show in the submission

- **Full outbound customer delivery still needs a verified sending domain.** With `onboarding@resend.dev`
  (no verified domain) Resend only delivers to the account's own address; test recipients (`delivered@`,
  `bounced@resend.dev`) simulate outcomes. Set a verified domain + `RESEND_FROM` on it for arbitrary customers.
- **The customer-reply resumption (D)** requires a human to send a reply to a `reply+<token>@` address — not
  scriptable here. The webhook path is optional (set `RESEND_WEBHOOK_SECRET`); polling is the default.
- A delivery status of `sent` means the provider accepted the send; it is **not** `delivered` until a
  delivery event confirms it (no webhook configured → status stays `sent`).
- **Browser portal login needs the local overlay** (`docker-compose.local.yml`) over plain http, because
  `NODE_ENV=production` sets Secure-only cookies. In real production (HTTPS) this is correct and needs no overlay.
- **Swagger `/docs` + `/openapi.json` are disabled when `NODE_ENV=production`** (009: non-prod only). The
  overlay sets `DOCS_ENABLED=1`.
- **Shops are not auto-seeded** — run `scripts/provision.ts` (step 4).
- **Worker/api start order:** the worker queries schema the api migrates first; a first-boot race
  self-heals via `restart: on-failure`.
- **T054 browser walkthrough** itself (steps 6–12 in a real browser) is a manual step — the automated
  supertest+real-Postgres suite and the live-API E2E above cover the same invariants, but a human still
  clicks through the pages.

## Operator recovery — incomplete first-admin bootstrap (D20.1)

If `/admin/init` ever fails and a later attempt is refused, the system is designed to **self-recover on
retry** — simply POST `/admin/init` again **with the same admin email**; a PENDING marker reconciles
(creates the admin, or completes an existing usable one). No lockout, no duplicate admin.

Two cases need an explicit operator step (both operator-gated; no unauthenticated reset exists):

1. **Pending init was started with a different email than you now want.** Inspect and clear the *pending*
   marker, then re-init:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.local.yml exec db \
     psql -U riverbend_migrator -d riverbend -c \
     "SELECT admin_user_id, status, admin_email FROM auth_bootstrap;"
   # Only if admin_user_id IS NULL (a failed/pending init, NOT a completed one):
   docker compose ... exec db psql -U riverbend_migrator -d riverbend -c \
     "DELETE FROM auth_bootstrap WHERE admin_user_id IS NULL;"
   # then POST /admin/init again.
   ```
2. **Pathological credential-less orphan** (`RecoveryRequired: incomplete admin account without a password`).
   Remove the orphan Better Auth user (verify it has NO credential and NO session first), then re-init:
   ```bash
   # Verify it is a true orphan (no credential, no session):
   docker compose ... exec db psql -U riverbend_migrator -d riverbend -c \
     "SELECT u.id, (SELECT count(*) FROM \"account\" a WHERE a.\"userId\"=u.id AND a.\"providerId\"='credential') creds,
             (SELECT count(*) FROM \"session\" s WHERE s.\"userId\"=u.id) sessions
        FROM \"user\" u WHERE u.email='<the admin email>';"
   # If creds=0 and sessions=0, delete the orphan user and the pending marker, then re-init:
   docker compose ... exec db psql -U riverbend_migrator -d riverbend -c \
     "DELETE FROM \"user\" WHERE email='<the admin email>'; DELETE FROM auth_bootstrap WHERE admin_user_id IS NULL;"
   ```
   **Never** delete a user with a credential or a session, and never touch a COMPLETED marker
   (`admin_user_id IS NOT NULL`) — that is a real, usable admin.

**Migration ordering note:** new migrations must be numbered AFTER all existing ones (the bootstrap fix is
`12000_…`, after `11100_…`); node-pg-migrate refuses a migration that precedes an already-applied one.

## Security update (D20.2) — ownership-proven bootstrap, fail-closed staff, full-origin CSRF

**Supersedes D20.1's reconcile-by-email.** The bootstrap now records only an admin it created and **never
adopts a pre-existing email-matched account**; `createStaff` likewise never adopts a pre-existing account.
Two consequences for operators:

- **A crash after the admin user is created but before it is recorded** now fails closed on retry
  (`RecoveryRequired: an account with this email already exists but was not created by this bootstrap`)
  rather than auto-adopting. Operator recovery (verify, then either adopt deliberately or remove the orphan):
  ```bash
  # Confirm the orphan is credential-less or the intended just-created admin, with NO prior session:
  docker compose ... exec db psql -U riverbend_migrator -d riverbend -c \
    "SELECT u.id, u.role,
            (SELECT count(*) FROM \"account\" a WHERE a.\"userId\"=u.id AND a.\"providerId\"='credential') creds,
            (SELECT count(*) FROM \"session\" s WHERE s.\"userId\"=u.id) sessions
       FROM \"user\" u WHERE u.email='<admin email>';"
  # Deliberate adoption ONLY if you are certain this user is the intended admin from the crashed bootstrap:
  #   UPDATE auth_bootstrap SET admin_user_id='<that id>', status='completed', initialized_at=now() WHERE id=true;
  # Otherwise remove the orphan (creds=0 AND sessions=0) and the pending marker, then re-init:
  #   DELETE FROM "user" WHERE email='<admin email>'; DELETE FROM auth_bootstrap WHERE admin_user_id IS NULL;
  ```
- **A failed staff creation leaves a NON-privileged orphan** (user with no membership → no access). A retry
  with the same email fails closed (`email already in use`); remove the orphan user (no membership, no
  session) with operator SQL, then recreate.

**CSRF / canonical origin (D20.2).** The portal validates the full `scheme://host:port` Origin (Referer
fallback) against an exact allowlist derived from `BETTER_AUTH_URL`: production is a single strict HTTPS
origin; development also allows the loopback sibling (`localhost` ⇄ `127.0.0.1`) at the same scheme+port. So
browse the portal at the SAME origin as `BETTER_AUTH_URL` (default `http://localhost:8080`); `127.0.0.1:8080`
also works in dev. A foreign origin, wrong scheme, wrong port, or `null` origin is rejected (403).

**Database role boundary (production gap).** Better Auth's runtime connection currently uses the
migrator/owner role. For production, provision a **dedicated restricted role** with privileges limited to
`user`/`session`/`account`/`verification` (no DDL, no access to tenant tables) and point `BETTER_AUTH`'s pool
at it. This is documented, not yet shipped (deferred near submission to avoid an unverified role migration).

## Browser login now works (D20.3) — canonical origin + CSRF

The admin/staff portal now logs in correctly in a real browser. Earlier, Helmet's default
`Referrer-Policy: no-referrer` made browsers send `Origin: null` on the login form POST, which the origin
guard rejected (403 "Request blocked") — while curl (no Origin) succeeded, masking the bug. Fixed with a
`strict-origin-when-cross-origin` referrer policy **and** an origin-independent double-submit CSRF token.

- **Browse the canonical origin:** `http://localhost:8080` (same as `BETTER_AUTH_URL`); `http://127.0.0.1:8080`
  also works in dev. In production use the single configured HTTPS origin.
- **Login / create-staff / disable / logout** all carry a CSRF token automatically (hidden `_csrf` field +
  `rb_csrf` cookie) — just use the rendered pages. **Logout is now a POST button** (not a link).
- **Scripting login with curl** now needs the CSRF flow (a browser does this automatically):
  ```bash
  # 1) GET the form → capture the rb_csrf cookie and the hidden _csrf token:
  curl -s -c cj.txt http://localhost:8080/admin/login -o login.html
  TOK=$(grep -oE 'name="_csrf" value="[^"]+"' login.html | sed -E 's/.*value="([^"]+)".*/\1/')
  # 2) POST with the cookie jar + the token + credentials:
  curl -s -i -b cj.txt -c cj.txt -X POST http://localhost:8080/admin/login \
    --data-urlencode email='<admin email>' --data-urlencode password='<admin password>' --data-urlencode "_csrf=$TOK"
  # → 302 to /admin with a session cookie (in cj.txt); reuse cj.txt for /admin/staff etc.
  ```
- **Security checks (observed live):** `Origin: null` **without** a token → 403; **with** a valid token → 401
  (passes CSRF; wrong creds). A foreign Origin → 403 even with a token. `/admin/init` is unaffected (it is
  authenticated by `ADMIN_BOOTSTRAP_TOKEN`, not a cookie, so it is not CSRF-gated).
- **Production reverse proxy:** set Express `trust proxy` to your proxy before any forwarded headers are
  believed; keep the single HTTPS origin in the allowlist. (Documented gap — not shipped.)

## Servicing classification (D22) — what to expect per message
When exercising the customer form or `/v1/messages`, these intents resolve deterministically (offline fake
or live model):
- "My bike needs general servicing" / "regular tune-up" / "routine maintenance" / "basic service" →
  **TUNE_BASIC**, a work order (TUNE_BASIC = **$65**), and **no clarification email**.
- "I need a complete overhaul" → **TUNE_FULL** ($185). "Inspect it / something feels wrong / a noise I can't
  locate" → **GENERAL_INSPECT**. "Replace the front brake pads" → **BRAKE_PADS**.
- "How much is servicing?" → a price inquiry (no work order). "Cancel my previous repair" → no new order and
  no auto-cancel (a person follows up). A genuinely vague message → exactly one clarification.
If a message is clear routine maintenance but you still see a clarification, check the extraction row
(`SELECT bikes FROM extractions WHERE request_id=…`) — empty serviceCodes indicate a model/prompt gap (D22).
