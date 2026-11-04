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

## 17. Known limitations to show in the submission

- **Resend credentials in the current `.env` are placeholders** (`RESEND_API_KEY` returns HTTP 401 to the
  real API; `RESEND_WEBHOOK_SECRET` is not a valid Svix secret). So real outbound (B), real inbound (C) and
  full delivery (D) are **BLOCKED** until a live key + a Resend-managed receiving address are set. The app
  degrades safely: the webhook self-disables with a warning; polling logs `resend inbound poll failed` and
  retries. **OpenAI/LiteLLM credentials are valid** and the live-AI path was verified (order $110.00).
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
