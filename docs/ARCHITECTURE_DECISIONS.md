# Riverbend Cycles — Architecture Decisions (D1–D18 + LLM orchestration)

Summarized from `docs/Riverbend_Architecture_Guide.docx` (Part 6 and Appendix A).
Each decision keeps the guide's own structure in compressed form: **Question → Pick →
Door type** (and the key "watch out" where it matters). "One-way door" = expensive to
undo, spend care here; "two-way door" = reversible, keep behind an interface.

This is the file the `/speckit-plan` step should be checked against (the guide calls it
`docs/decisions.md`; we name it `ARCHITECTURE_DECISIONS.md`).

---

## The final design in one paragraph

One codebase, one container image, **two processes**: an **API** that answers quickly and
never calls the model, and a **worker** that does the slow AI work. One **PostgreSQL**
database holds everything (messages, requests, jobs, work orders, AI spend ledger, mail
outbox). Every shop is fenced with **forced row-level security**. A message is saved
(message + request + job) in **one transaction** before the API returns **202 Accepted**;
the same message twice yields the same request. **The AI reads a strict form; code decides
and prices** from the catalog in whole cents. A **per-shop monthly budget** is enforced by a
reserve-then-settle ledger. If the AI is slow/down, bounded retries then park as
`needs_review`; the queue drains on recovery. Runs locally with `docker compose up`;
deploys to GCP (Cloud Run, Cloud SQL, Vertex AI, Secret Manager) via Terraform.

### The eight invariants (each must have a test)

- **I1** No request can read another shop's data.
- **I2** At most one work order per request **and** bike.
- **I3** No model output is saved unless it passed schema validation.
- **I4** AI spend never exceeds a shop's monthly cap.
- **I5** price = catalog price × quantity, in integer cents.
- **I6** At most one follow-up question per request.
- **I7** No secret is ever committed.
- **I8** Any request that may need asynchronous clarification has a valid, authorized reply
  path (mandatory web-form email; reliable email conversation correlation). The delivery
  channel and provider stay implementation decisions (D10, D11). Added in constitution v1.1.0.

---

## D1 — One codebase, or many services?

**Pick:** Modular monolith — one image, two processes (API + worker). Boundaries enforced
in CI by `dependency-cruiser`; a module imports only another's public entry file and reads
no other module's tables. **Why:** the brief's hard parts (duplicates, crashes, caps) are
consistency problems, easiest when one DB transaction covers a message's writes. **Door:**
two-way (a module — the AI worker first — can be split out later).

## D2 — Keeping shops apart

**Pick:** Shared tables + `tenant_id` everywhere + **composite foreign keys** + **row-level
security enabled and forced**, guarded by a build test that fails if any `tenant_id` table
lacks a policy. App connects as a non-owner `app_user` with no bypass; migrations run as a
separate role. Shop id comes from the **authenticated key**, never the request body; set per
transaction via `set_config(..., true)`. Documented cross-shop exceptions: job queue (ids
only), API-key lookup (hashes), shared catalog. **Door:** **one-way** (adding `tenant_id`
later is the expensive part — do it now). Change only if a customer contractually needs
physically separate data → move that shop to its own cell.

**Implementation refinement (slice 001, recorded by converge 2026-11-03):** the "API-key lookup /
provisioning" cross-shop exception above is realised by a **second non-owner runtime role,
`app_admin`** (connection `DATABASE_ADMIN_URL`), used only by the admin/auth module. Both runtime
roles are **`NOBYPASSRLS` and non-superuser**; `app_user` carries a tenant-scoped RLS policy and
`app_admin` a permissive policy **on only the identity tables** (`shops`, `credentials`). `app_admin`
has no default privileges on future tables (a new `tenant_id` table is denied until a migration
grants it), so **customer-content tables — messages, conversations, work orders — must remain
`app_user`/tenant-scoped only** and must never be granted to `app_admin`. See
`specs/001-foundation/data-model.md` for the exact grant/policy table.

## D3 — Taking a message in, and duplicates

**Pick:** One transaction saves message + request + job, then return **202**. Idempotency
via a **unique key on (shop, source, external message id)** with insert-on-conflict. Same id
+ same body replays the same answer; same id + different body → **409**. Web form supplies a
browser-generated random id; public submissions use the server clock. **Door:** **one-way**
(keys and the 202-plus-status contract are public API).

## D4 — The job queue

**Pick:** **pg-boss** behind our own `JobQueue` interface, plus a **sweeper** that rebuilds
stuck work from request state. The queue is "a doorbell, not the memory" — the DB holds
truth; handlers are safe to run twice. Job expiry set above one worst-case run; never hold a
DB transaction open across the AI call. **Door:** two-way (interface). Move the AI step to
Pub/Sub / Cloud Tasks at ~10,000 shops.

## D5 — Request states & the one follow-up question

**Pick:** **Code decides from the validated form; the AI only drafts wording** (length-capped,
no prices/links/PII, same language, else a fixed template). States: `received`, `processing`;
final — `ordered`, `answered`, `cancelled`; waiting — `awaiting_customer`, `held_budget`,
`needs_review` (with a fixed reason list). "Required" = ≥1 catalog service (+ which wheels for
per-wheel work); bike type and date never block. One bundled question max; a DB `CHECK` keeps
the follow-up count ≤ 1. After the one reply, unresolved-with-symptom → general inspection
(USD 25), else needs review. Price inquiry → answer, no order. Wrong shop → needs review
("wrong shop suspected"), never auto-moved. **Door:** mostly two-way (policy is code); status
names are additive-only public API.

## D6 — The AI gateway and the model

**Pick:** **LiteLLM proxy** behind our own `LlmGateway` interface; run the **official Docker
image pinned by digest**, internal-only network (the March 2026 PyPI compromise is why). Model
chosen by **measured quality** on the 40-sample golden set, not price — config names a *class*:
a fast "Flash-class" primary on **Vertex AI** (service account, no API key), a stronger model
for escalation, a third-provider fallback. Cascade: primary → on validation failure retry once
with the stronger model → else needs review. **Door:** two-way. A cheaper/local model at the
cap is a future adapter, not built.

## D7 — The monthly AI spend cap

**Pick (as of 2026-11-04, constitution 1.2.0):** **LiteLLM-native budgets are the admission and
accounting authority.** One LiteLLM **team per shop** with a configurable **$5 calendar-month** cap,
and **restricted virtual keys** the worker uses for inference (never the master key, which is confined
to a provisioning/admin path). Admission is **reservation-based and fail-closed**: a call over budget
is rejected **before reaching the provider** → the request parks `held_budget`; if budget state cannot
be verified, real inference fails closed into a recoverable state. The real cost
(`x-litellm-response-cost`), model, tokens, and LiteLLM request id are captured **against the Riverbend
request** in whole millionths; an **idempotent reconciliation** against LiteLLM's spend-log API records
proxy-calculated cost without double-counting. Riverbend retains tenant identity, the `held_budget`
state, usage reporting, request-level cost references, and the **calendar-month reset** (business
policy); a request-scoped usage record — **not** a second reservation engine — prevents a redelivered
job from charging twice.

**Measured limitation (2026-11-04, constitution 2.0.0).** Zero-cost testing (LiteLLM 1.106.6 + Postgres,
mock upstream + configured pricing) confirmed native enforcement **rejects fail-closed** but is
**eventually-consistent**: it can exceed a team cap by **~one in-flight call** (spend flush lag). So
LiteLLM-native is a **bounded soft cap**, not a hard one — this is why I4's guarantee was amended from
"never exceeds" to "bounded single-in-flight-call overshoot". The owner approved making LiteLLM the sole
authority with this known trade-off. Mitigation: set each team budget at/below the chain cap; per-call
cost is micros, so the overshoot is immaterial. (The brief's original "calendar vs rolling" worry: the
observed `budget_reset_at` was the first of the next month — calendar-aligned — to be pinned in Phase 5.)

**Migration & rollback.** Cutover performed (`BUDGET_AUTHORITY=litellm`, the new default): the pipeline
no longer calls `reserve`/`settle` for enforcement; it resolves the shop's virtual key, lets the proxy
admit/deny, and records the proxy-calculated cost per request for accounting. The legacy `BudgetService`
and `shop_budgets`/`llm_calls` tables are **kept, not dropped** — `BUDGET_AUTHORITY=legacy` restores the
hard-cap reserve-then-settle path for rollback (or for a shop that needs a strict cap). **Door:** the
financial *records* stay one-way (kept, never rewritten); the enforcement engine is two-way behind the
flag. See `docs/decision-log.md` (2026-11-04) and Feature 003 FR-007/FR-008.

**Original Hybrid pick (superseded, kept for history):** Postgres reserve-then-settle ledger as the
authority; per-shop LiteLLM budget as a seatbelt; atomic `spent + reserved + estimate <= cap`; receipt
keyed by (request, step, attempt) for crash-replay; reaper for abandoned holds; `held_budget` at the cap;
resume oldest-first on month rollover.

## D8 — Work orders and money

**Pick:** **One work order per bike**, all-or-nothing in one transaction, unique key on
(shop, request, bike number). The AI fills a strict form (which bikes, which service codes,
which wheels); **code computes** quantity × unit price. Money in **whole cents**; AI spend in
**whole millionths of a dollar**. Each item **copies the unit price and catalog version** at
creation so later price changes never rewrite history. `requires_inspection` items are included
at listed price, shown "price confirmed after inspection". Examples: m-1029 = (35+40)×2 = **USD
150**; m-1040 = two bikes × tune-up = **USD 130**. **Door:** **one-way** (order shape + money
format expensive to change once real data exists).

## D9 — Cancelling, and non-exact duplicates

**Pick:** **Never cancel on a name match alone.** A **verified channel** (email from the
original address with SPF/DKIM passing and exactly one open match; or a signed web cancel link)
cancels automatically; otherwise staff get a **SQL-built proposal** of candidates to confirm.
The processing race is settled by a **cancel flag + a locked re-check at the final commit** (a
stale worker's result is discarded). Look-alike cross-channel requests are **flagged, never
merged** (same contact, overlapping services, within 24h). Sample m-1038 has no sender address →
staff-confirm path. **Door:** two-way for the matching rules; the "never cancel on a name match"
safety rule is not reversed without a security review.

## D10 — Real email, in and out

> **Superseded by D21 (2026-11-04):** the provider is now **Resend** (sole provider); Mailgun/Mailpit/
> SMTP are retired. The transport port, outbox, signed `reply+<token>@` correlation, Message-ID de-dup,
> one-round rule and failed-send→needs_review are all unchanged — only the provider and inbound/verify
> mechanism changed. Original text kept for provenance.

**Pick:** A transactional provider (**Mailgun** default) behind `EmailTransport` + an inbound
adapter; **Mailpit** locally with a signed-payload script exercising the real inbound path.
Replies matched by a **signed, expiring `reply+<token>@` address** plus `In-Reply-To`/`References`
headers; quoted text stripped; auto-replies/bounces/attachments handled; SPF/DKIM/DMARC verdicts
checked before trusting a sender for anything sensitive. Outbound goes through the **outbox** with
retries; repeated failure → needs review ("delivery failed"); a failed send never rolls back an
order. Inbound de-duplicated by `Message-ID`. **Not built:** going live on a real domain (DNS/MX/
SPF/DKIM) — documented ops step. (GCP blocks port 25; use a provider.) **Door:** two-way.

## D11 — The web form as a real integration

**Pick:** A **hosted, hardened form per shop** (+ optional iframe embed) using the common intake
path, with a status page and magic links. Fields: **email required**, name/phone optional,
message ≤ ~2,000 chars, consent line. Defences (outside-in): public shop key (selector, not a
secret), origin allowlist + CORS, **Cloudflare Turnstile verified server-side**, per-IP/per-shop
rate limits, honeypot, size limits + strict validation, browser idempotency key, output encoding
+ strict CSP, and the shop's AI cap as the last line. Phone-only is **rejected** (no reply path;
SMS is not built). **Door:** two-way for the page/widget; submission API + status names are
additive-only public API. (Guide's effort estimate: 8–12h — the biggest single item beyond the
brief; the bot-check widget is the last thing cut, server-side checks stay.)

## D12 — The web framework: Express

**Pick:** **Express 5 + TypeScript**, with **Zod** route contracts via a typed-route helper (a
contract test fails the build if a route lacks schemas), `helmet`, `express-rate-limit`,
`pino-http`, `supertest`, `zod-to-openapi`. Express 5 forwards async errors to the error handler.
**Webhook routes read the raw body before any JSON parser** (signature over exact bytes) — tested.
Business logic (modules, state machine, pricing) does **not** import the framework. **Door:** two-way.
*(This reversed the guide author's earlier Fastify push — "your idea wins".)*

## D13 — Observability

**Pick:** **OpenTelemetry everywhere** (traces/metrics/logs), backend swappable: **Phoenix**
locally, **Cloud Trace/Logging/Monitoring** on GCP, optional Langfuse later — no code change.
Trace context travels in the job (`traceparent`) so API + worker join one trace. **Money is never
read from traces** (sampled, non-transactional) — `llm_calls` is the source of truth. Logs are
pino JSON carrying trace/request/shop ids; **message text never logged**, PII redacted in traces.
Eight alerts, each with an owner + one-line runbook. **Caveat:** OTel GenAI attribute names may
still change — keep them in one place. **Door:** two-way.

## D14 — Security beyond tenant isolation

**Pick:** **Hashed, per-shop, revocable API keys** (prefix + SHA-256, constant-time compare,
rotation, last-used) for staff/systems; **signed single-purpose HMAC tokens** (status/reply/cancel,
with key id) for customers. **Prompt injection made low-impact by design** (no tools/memory/secrets
/shop-list for the model; strict output form with fixed choices; prices never in the prompt; code
limits urgency; suspicious messages flagged) — see m-1024. **Secrets:** Secret Manager in prod;
`.env` git-ignored + `.env.example`; typed settings validated at startup; **gitleaks** in CI +
pre-commit. **Supply chain:** lockfiles, `npm ci`, digest-pinned images, Dependabot, SBOM, image
scan, non-root, GitHub→GCP via Workload Identity Federation (no key files). No SSRF: never fetch a
user-supplied URL. Mapped to the **OWASP API Security Top 10 (2023)**. **Door:** two-way for the
login method; "shop id comes from the credential, never the request body" is permanent.

## D15 — Privacy & data handling

**Pick:** Keep full text for a **configurable period (proposed 90 days)**, then reduce to metrics +
fingerprints; work orders are business records, kept. **Never log message text.** Check each
provider's **DPA** and data location before sending real customer text (no "doesn't train on your
data" claims). Encryption in transit + at rest, backups + PITR. **Erasure designed, not built.**
Consent line on the form. **Door:** two-way for retention length; "never log message text" is kept.

## D16 — When things fail

**Pick:** Bounded retry → park with automatic drain (option C). Every AI call has a **timeout**;
retries are **bounded with exponential backoff + jitter**; **only one layer retries** (keep
LiteLLM's retry count low); a **circuit breaker** per process; a **per-shop bulkhead**; a global
"AI paused" switch. The customer always sees an immediate 202; after a deadline, honest "a person
will follow up". A redelivered job replays the recorded AI answer (no double charge); a failed
email → needs review, order never rolled back. See the failure matrix in the guide (Table 68).
**Door:** two-way. Automatic fallback to a second provider (option D) is added later behind the
gateway, once that provider passes review.

## D17 — The staff screen

**Pick:** **Server-rendered pages from the same Express app** (option B) — no separate frontend.
Sign-in: paste the shop API key → short-lived signed session cookie (HttpOnly, Secure,
SameSite=Strict); every action is a form post with a **CSRF token**; strict CSP. Pages: **Needs
attention** (waiting/delayed/held/flagged, with reason + age), **Open work orders** (items +
totals, grouped by request), **AI usage** (spend vs cap, held count, paused?), **Request detail**
(timeline, extraction, price breakdown; actions: retry, resume, approve extraction, confirm cancel,
mark handled). **Not built:** manual order creation, staff roles. Honest con: audit shows which
key acted, not which person. **Door:** two-way.

## D18 — Running it on Google Cloud

**Pick:** **Cloud Run** (API service + **worker pool**) + **Cloud SQL for Postgres** (private IP,
HA standby, PITR) + **Vertex AI** (service account) + **Secret Manager** + **Artifact Registry** +
an external HTTPS load balancer with **Cloud Armor** in front of the public form/webhook. LiteLLM
runs as an internal-only Cloud Run service with its own small DB. Migrations as a Cloud Run job
using **expand-and-contract**. **Terraform + GitHub Actions via Workload Identity Federation**;
CI runs `terraform validate` + `plan` — **no live deploy** (brief allows IaC + plan to score the
same). **Caveats to verify:** worker pools **do not autoscale** (fixed count at 100 shops, or add
the CREMA autoscaler); Cloud SQL Managed Connection Pooling needs Enterprise Plus and has
transaction-mode limits — test RLS `set_config` and pg-boss through it before relying on it.
**Door:** two-way (the container runs anywhere).

---

## The three decisions most worth challenging (for the 2-page note)

1. **A shared database with strong isolation**, not DB/schema per shop. Wrong if a customer needs
   physically separate data or a noisy neighbour can't be contained → move that shop to its own cell
   (a data move, not a rewrite, because every row carries the shop id).
2. **Postgres as the one durable store for the workflow, including the queue.** Message + request +
   job in one transaction; pg-boss runs jobs; a sweeper rescues stuck work; each model call recorded
   before anything else is saved. Wrong if sustained load hits hundreds of jobs/sec or queue-table
   bloat bites → swap the queue behind `JobQueue`.
3. **The model interprets; code decides and prices.** Strict form with fixed choices; code validates,
   decides the question, maps to catalog codes, computes totals. Wrong if the general-inspection
   fallback fires so often customers feel unserved → the catalog is incomplete, or the rules are too
   strict (tune on labelled samples).

---

## Additional decision — LLM orchestration (cross-cutting)

This is the orchestration contract that ties D5–D8 together, stated explicitly for the plan:

- **LiteLLM Proxy for model integration.** All model traffic goes through LiteLLM (digest-pinned,
  internal-only) behind our own `LlmGateway` interface (D6). One place for keys, routing, fallbacks,
  per-shop budgets and cost data.
- **Structured LLM extraction.** The model's only job is to fill a **strict, schema-validated form**
  (bike(s), issues, catalog service codes, wheels, urgency, the customer's own date words). No free
  text is trusted; output failing validation is never saved (I3).
- **The TypeScript backend owns workflow state and side effects.** All state transitions, idempotency,
  pricing (I5), budget ledger (I4), the one-follow-up rule (I6), work-order creation (I2), email
  sending and cancellation live in code — never in the model. The model has no memory, no tools, no
  secrets, and no list of shops.
- **The LLM proposes, it never acts.** The model may **propose** a follow-up question's wording, but
  **cannot directly send emails or create work orders.** Code gates the draft (length, no prices/links/
  PII, correct language, else a template), decides whether to ask at all, and performs every side
  effect. This is also the core prompt-injection defence (D14, sample m-1024).

**Door:** the gateway and model are two-way (swap the adapter); "code owns money, decisions and side
effects; the model only proposes structure" is a **one-way**, constitutional rule.

---

## Contradictions & divergences — NOT silently resolved

Flagged for a human decision (see also `REQUIREMENTS.md` Part D):

1. **Effort vs scope (explicit in the guide).** Brief: ~**8 hours**. Guide plan: ~**25–38 hours**
   for Layer 1+2 (Table 76: ~38h total). The guide offers "**Layer 1 only** stays near 8 hours and is
   a complete, honest answer." → *Decision needed: which layer do we actually build and declare?*
2. **"Synthetic / throwaway" vs "production-grade" framing.** Brief: "We will not use your work…
   nothing you build here goes into our codebase," and the data is synthetic. Guide **Promise 3
   withdraws** the synthetic-data framing and designs for real customers, real PII and real money.
   → *A deliberate stance, but it diverges from how the brief frames the exercise.*
3. **Spec Kit integration key.** Guide Appendix B: `specify init riverbend --integration copilot`,
   and "command names… are the ones the quickstart shows for the Copilot integration." This project
   uses `--integration claude` (per the engagement; skills are `/speckit-*`). → *Already decided as
   Claude; recorded here so the divergence from the guide's literal instructions is explicit.*
4. **Dataset shape.** Brief: "**40** sample messages, **8** deliberately tricky." Guide: only **39
   distinct IDs** (m-1003 delivered twice — rows 3 and 14; no m-1014), and it treats **more than 8**
   messages as tricky (m-1003, m-1005, m-1009, m-1018, m-1024, m-1025, m-1027, m-1029, m-1033, m-1035,
   m-1037, m-1038, m-1040 …). → *Confirm the intended "tricky 8" and the 40-vs-39 count before building
   the results table.*
5. **m-1005 expected outcome (internal uncertainty).** The guide reads m-1005 ("rear brake squeals +
   gears skip on hills") as resolvable without a follow-up because the rear wheel is named, but adds
   "**Confirm which brake service your golden set expects.**" → *Golden-set label to be fixed by a human.*
6. **Unverified technical assumptions (guide Appendix E).** The guide explicitly could not verify, among
   others: Cloud Run worker-pool autoscaling / CREMA launch stage; Cloud SQL Managed Connection Pooling
   behaviour with RLS `set_config` and pg-boss; LiteLLM calendar-month budgets and fail-open behaviour;
   Postmark inbound webhook signing; OTel GenAI attribute stability; pg-boss install privileges. → *Treat
   each as an assumption to test during the relevant slice, not a settled fact.*

## D19 — API access, credential lifecycle, and docs (Feature 009)

**Pick:** Keep the **API-first, shop-API-key** model (no human identity platform: no passwords,
sessions, invitations, or RBAC users). Harden the existing credential with **scopes** (empty = legacy
unrestricted), **expiry**, **rotation**, **masked listing**, and an **ids-only audit log**
(`credential_audit`). `ADMIN_BOOTSTRAP_TOKEN` stays a restricted platform-operator credential for the
admin path only. OpenAPI 3 + Swagger UI at `/docs` document the API in **non-production only**. A
`make provision` command gives a no-SQL local demo (idempotent; never silently rotates). **Three key
kinds stay distinct and are never confused:** admin credential (operator, `/admin`), shop API key
(tenant, `/v1`), and the internal per-shop **LiteLLM virtual key** (never returned by any endpoint).
**Secrets are shown once** and stored only as SHA-256 fingerprints — never retrievable. **Door:** mostly
two-way (scopes/expiry/docs are additive); the API-key model itself is one-way (public contract).
**Not built (documented):** human accounts/SSO, per-endpoint RBAC beyond coarse scopes, a production
browser login. See `specs/009-api-access-docs/spec.md`.

## D20 — Human authentication library + staff portal (Feature 010)

**Pick:** **Better Auth 1.7.16** (MIT) for human email/password authentication, via its **native `pg`
Pool adapter** (no Prisma/Drizzle, no new ORM) + the `admin()` plugin; public signup disabled. Better
Auth owns authentication (password hashing/verify with its maintained secure default, sessions,
login/logout, rate-limiting, cookie/CSRF security). **Riverbend keeps authorization**: a
`shop_membership(user_id, shop_id, role, status)` table maps a Better Auth user to shops/roles
(PLATFORM_ADMIN / SHOP_ADMIN / SHOP_STAFF); every protected read resolves tenant from the session →
active membership → existing tenant-bound service → **forced RLS** (never a client `shop_id`). The first
admin is created by a **single-use, bootstrap-token-gated** init via `auth.api` (never a hand-built
password row). A server-rendered portal (`/admin/*`, `/staff/*`) reuses existing domain services; prices
are catalog/code only. **Three credential systems stay separate and never fall back to each other:**
Better Auth sessions (browser), Feature 009 shop API keys (`/v1`), LiteLLM virtual keys (worker→proxy).

**Boundary (deliberate deviation):** Better Auth's identity tables live in a dedicated **`auth` schema**
and are **NOT** under tenant RLS (its identity operations are global); they carry no `shop_id`, so the
isolation policy-check does not apply. Schema is generated by the official CLI and committed as a
**reviewed migration** — no runtime schema mutation in production.

**Why not:** Lucia (deprecated) — rejected. Hand-rolled Passport/session/password — rejected (reinvents
a maintained library's security surface). JWT/SSO/microservice — out of scope for this MVP.

**Risks/maintenance:** Better Auth is young/fast-moving (pin + review on upgrade); its admin plugin can
expose broad privileges → we wrap server-side with allow-listed fields and our own role checks; cookie
Secure/HTTPS + trusted-proxy must be set in prod. **Door:** two-way (auth behind our session guard), but
stored identity records are one-way (kept). See `specs/010-staff-auth-portal/`.

## D21 — Resend as the sole email provider (supersedes D10's provider choice)

**Pick:** **Resend** is the only supported email provider (official `resend` SDK **6.37.0**; webhooks
verified with **Svix** `2.9.1`). Mailpit, SMTP and `nodemailer` are removed from the runtime and from the
supported deployment. **Outbound** goes through the unchanged `email_outbox` relayed by the worker via a
new `ResendTransport` — `resend.emails.send({…}, { idempotencyKey: rb-followup-<request_id> })` so job
retries never double-send (24h provider dedupe + our `UNIQUE(request_id)`); transient failures (network/
429/5xx) keep the row pending with bounded backoff, permanent failures and exhausted retries park the
request `needs_review` (a worker crash never loses a durable send). **Inbound** uses Resend's `email.received`
webhook at `POST /webhooks/resend`: the API verifies the **Svix** signature over the **raw body**, durably
records the provider event (`email_events`, de-duped by `svix-id`) **before** the 200 ACK, and the **worker**
then fetches the full message with `resend.emails.receiving.get(email_id)` (the webhook is metadata-only)
and runs the existing signed-token correlation + Message-ID de-dup + one-round guard. Delivery/bounce events
(`email.sent/delivered/bounced/failed/delivery_delayed`) update a monotonic `delivery_status` — an API-200
is **not** "delivered" until the `delivered` event arrives.

**Trust boundary:** the `from` header is never trusted alone — authority is the signed `reply+<token>@`
address (binds shop+request); SPF/DKIM/DMARC verdicts from the Receiving API are recorded for observability.
`email_events` is a **global** provider-ingestion log with no `shop_id` and no PII (so it is outside the
shop_id→forced-RLS policy-check, same deviation class as the Better-Auth tables, D20); `email_outbox` /
`inbound_emails` remain shop-owned under forced RLS.

**Local testing (domain-free):** inbound works via a Resend-managed `<id>.resend.app` receiving address +
the `resend webhooks listen` CLI (no built-in tunnel — supply a public URL). Outbound before domain
verification may only send to the account's own email; a full two-way customer round (TEST C) is **BLOCKED**
until a sending domain (SPF/DKIM) is verified — marked BLOCKED, never fabricated.

**Why Resend:** first-class inbound receiving + content API, official SDK, Svix-standard signed webhooks,
idempotency keys, and domain-free inbound testing — a single provider for both directions. GCP blocks
port 25, so a provider is required anyway (matches D10's rationale). **Why not** Mailgun/Mailpit/Gmail/IMAP/
SMTP/separate microservice: rejected — one provider, no second service, HTTPS-only. **Door:** two-way (the
transport + verifier are ports; a future provider swap touches only the adapters). See `specs/006-email/`.

## D21.1 — Inbound by Resend Receiving-API polling (default local/MVP; webhook optional)

**Pick:** For local development and the MVP, inbound replies are discovered by **polling the Resend
Receiving API** instead of requiring a public webhook — so a reviewer needs **no public URL, webhook, or
tunnel**. A **pg-boss self-rescheduling singleton job** runs every `RESEND_POLL_INTERVAL_SECONDS` (default
60): it lists received emails (`resend.emails.receiving.list`, paginated with `limit`/`after`), discovers
each email id into the existing `email_events` log (de-dup by id), then the existing `processPendingEvents`
fetches content (`receiving.get`) and runs the unchanged correlation. The **signed webhook (D21) is
preserved but off by default**, enabled only when `RESEND_WEBHOOK_SECRET` is set (production, lower latency);
the two may run together — Message-ID de-dup yields one work effect.

**Single-flight + durability:** a durable DB **lease** (`email_poll_state.claimed_until`) ensures only one
poller runs at a time across instances (a second no-ops); the pg-boss singleton is a second guard. Each
discovered id is persisted **before** the checkpoint advances, so overlapping scans, partial pages, and
restarts never duplicate work (de-dup + the `awaiting_customer` one-round guard are the final gates). A
list/API failure releases the lease without advancing and the next tick retries (bounded, interval-paced).

**Known limits (documented, not fabricated):** Resend does not document received-email **ordering** (so
correctness never depends on it — de-dup by id is authoritative) or **retention** (assumption: recent emails
remain listable; at 60s this is safe for dev/MVP, and production should prefer webhooks). The general API
rate limit is 10 req/s; a tick is bounded to `maxPages` list calls + one `get` per new email. **Door:**
two-way — polling and webhook are independent inbound adapters over the same durable pipeline. See
`specs/006-email/` (D21.1 sections).

## D21.2 — Compact reply-correlation token (live-provider fix)

**Pick:** encode the `reply+<token>@` token as the two UUIDs packed as **raw bytes** (16+16) plus a 10-byte
truncated HMAC, in a single base64url blob (42 bytes → 56 chars). **Why:** live testing against the real
Resend API showed the previous string-encoded token produced a **142-char** email local part, which Resend
rejects with **HTTP 422** (RFC 5321 caps a local part at 64 chars) — so every real clarification email
failed and parked `needs_review`. The compact form is **62 chars** (≤64) and keeps the signed-correlation
security (80-bit MAC, backed by the one-round + `awaiting_customer` + Message-ID de-dup gates).
`mintReplyToken`/`readReplyToken` keep their signatures; nothing else changed. Verified live: a real
clarification then sent successfully (outbox `sent`, provider id persisted). **Door:** two-way (encoding-only).

## D20.1 — Recoverable first-admin bootstrap (P0 fix)

**Problem:** the original bootstrap did `INSERT auth_bootstrap` → Better Auth `createUser` → `UPDATE
auth_bootstrap` with a try/catch compensation. Better Auth (its own migrator Pool) and the marker
(app_admin Pool) cannot share a transaction, and the compensation does not survive a **process crash**
between steps. A crash left a marker with `admin_user_id = NULL` while `isInitialized()` counted ANY row
→ permanent 409 lockout with no usable admin. (Confirmed by fault-injection, not guessed.)

**Pick:** a **recoverable two-phase marker** keyed on the hard invariant `admin_user_id IS NOT NULL`
(COMPLETED); anything else is PENDING/retryable. `auth_bootstrap` gains `admin_email` (binds a pending
init to one email) and `status` (pending|completed mirror). `initFirstAdmin`:
reserve-or-read (`INSERT … ON CONFLICT DO NOTHING`, `id=true` serializes concurrency) → if COMPLETED
reject (409) → else create the admin, or if a prior/concurrent attempt already created it
(`USER_ALREADY_EXISTS`) reconcile to that user **after verifying it has a credential** → record
`admin_user_id` to COMPLETE. On any error the marker stays PENDING (no delete) so a retry reconciles — no
lockout. Concurrency converges on one admin (same id); a different-email retry against a pending marker is
refused; a persistent credential-less orphan is flagged `RecoveryRequired` (operator step) rather than
falsely completed. Better Auth's admin `setUserPassword`/`removeUser` are **UNAUTHORIZED without an admin
session** (verified), so recovery never depends on them; identity reads use Better Auth's own Pool.

**Staff creation** made retry-safe the same way: verify the shop first (no orphan identity on a bad shop);
on duplicate email reconcile **only** an orphan identity (no membership) — never silently attach a real
account to a new shop; membership upsert is idempotent (`unique(user_id, shop_id)`). **Door:** two-way
(a new reviewed migration `12000_bootstrap_state.cjs`; identity records are kept). See `specs/010-staff-auth-portal/`.

## D20.2 — Ownership-proven bootstrap + full-origin CSRF + fail-closed staff (supersedes D20.1 reconcile-by-email)

A security re-audit of D20.1 found three real defects (confirmed by fault injection, not tests-pass optimism):

1. **Unauthorized account adoption (P0).** D20.1 reconciled a pending bootstrap to a user *found by email*.
   An email-matched **pre-existing** account could thus be granted platform-admin. **Fixed:** the bootstrap
   now only ever records an `admin_user_id` that **this flow created** (`createUser` → record immediately →
   complete). A `USER_ALREADY_EXISTS` with no recorded id is **never adopted** — it waits briefly for a
   concurrent winner's recorded id, else fails closed (`RecoveryRequired`, operator step). Completion ⟺
   `admin_user_id IS NOT NULL`, now also enforced by a DB CHECK (`12100_bootstrap_consistency.cjs`). This
   trades auto-recovery of the rare crash-after-create window for a safe operator step — the audit's mandate.
2. **Staff adoption (P0).** D20.1's "no membership ⇒ orphan ⇒ adopt" even matched the platform admin (who
   has no membership). **Fixed:** `createStaff` **never** adopts a pre-existing email — a duplicate fails
   closed (`email already in use`). The shop is verified before any identity is created; a crash leaves a
   NON-privileged orphan (no membership → no access) for operator cleanup.
3. **CSRF host-only check (P1).** The origin guard compared `host` against one `baseUrlHost`, so a legit
   `127.0.0.1` browser was rejected while `localhost` was configured, and scheme wasn't validated. **Fixed:**
   `trustedOriginsFor()` builds an exact `scheme://host:port` allowlist (prod = one strict HTTPS origin; dev
   also allows the loopback sibling), shared by Better Auth and the portal guard; the guard matches the full
   normalized Origin (and Referer fallback), blocking foreign origin / wrong scheme / wrong port / null, and
   allowing a missing Origin (same-origin form, backed by SameSite cookies). Never fixed by disabling CSRF.

**DB role boundary (documented gap, not an unverified migration):** Better Auth's runtime Pool currently uses
the **migrator/owner** role. Production should use a **dedicated restricted role** with privileges only on
`user`/`session`/`account`/`verification` (no DDL, no access to tenant tables). Introducing that role near
submission is deferred and documented rather than shipped unverified. **Door:** two-way; identity records kept.
See `specs/010-staff-auth-portal/` and `docs/FINAL_MANUAL_TEST.md`.

## D20.3 — Browser-login 403 root cause + double-submit CSRF (extends D20.2)

**Symptom:** curl `POST /admin/login` → 302 + session, but a real **browser** → **403 "Request blocked"**.
**Root cause (file-evidenced, not guessed):** `app.use(helmet())` (`src/api/app.ts`) applied Helmet's default
**`Referrer-Policy: no-referrer`**, which makes browsers send **`Origin: null`** on an ordinary same-origin
HTML form POST (MDN). The D20.2 origin guard (`src/api/portal-routes.ts`) treated an unparseable `null`
origin as foreign → 403. curl sends no Origin, so it was allowed — which is exactly why "it works in curl"
was misleading (a curl 302 is NOT a browser session).

**Fix (smallest secure, two independent layers):**
1. **Referrer-Policy → `strict-origin-when-cross-origin`** (hygiene): same-origin form POSTs again carry a
   real `Origin`, so the common browser case passes on the allowlist.
2. **Double-submit CSRF token (primary, origin-independent)** on every cookie-authenticated state-changing
   portal POST: a GET sets an **HttpOnly, SameSite=Lax** `rb_csrf` cookie and embeds the same value in a
   hidden `_csrf` field; the POST must present a matching pair (constant-time compare). A cross-site POST
   can neither read the HttpOnly cookie/field nor (SameSite=Lax) send the cookie, so it can never forge a
   matching pair — **even with `Origin: null`**. The exact-origin allowlist (scheme+host+port, dev adds the
   loopback sibling) remains as defense-in-depth: a present, parseable, foreign Origin is refused outright.
   Both layers must pass.

Applied uniformly to admin/staff **login**, **staff create**, **disable**, and **logout** (migrated from a
CSRF-forgeable **GET** to a **POST** + token). `/admin/init` is **not** CSRF-gated — it is authenticated by
the `ADMIN_BOOTSTRAP_TOKEN` secret (not an ambient cookie), so CSRF does not apply.

**Rejected workarounds (and why):** globally allowing `Origin: null` (would accept cross-site opaque-origin
forgeries); disabling CSRF or the guard (removes the defense); wildcard CORS / trusting arbitrary
Referer / `Sec-Fetch-Site` alone (spoofable or insufficient); weakening cookie flags; changing password
verification. **Production:** strict single HTTPS origin allowlist (`BETTER_AUTH_URL`); `Secure` + SameSite
cookies; a reverse proxy must set a trusted `trust proxy` before forwarded headers are believed (documented
gap — not enabled by client-controlled headers). **Local:** browse the canonical origin
(`http://localhost:8080`; `127.0.0.1:8080` also allowed in dev). **Door:** two-way. Verified live: GET sets
the new Referrer-Policy + `rb_csrf`; `Origin: null` without a token → 403, with a valid token → 401 (CSRF
passes); foreign origin → 403. See `specs/010-staff-auth-portal/` and `docs/FINAL_MANUAL_TEST.md`.

## D22 — Catalog classification taxonomy for maintenance vs. clarification (refines D3/D5)

**Problem (real user regression):** "My bike needs general servicing" produced a clarification email
("What specific issues…?") instead of a work order. Root cause: the extraction prompt (and the offline
FakeGateway) treated a clear routine-maintenance request as having *no clearly-applicable code* → empty
`serviceCodes` → `decide()` asked the one follow-up. The model, not the deterministic policy, was the
weak point (it was told "if no allowed code clearly applies, leave serviceCodes empty").

**Pick:** teach the extraction a small, generalizable **semantic taxonomy** (in the system prompt — not
hardcoded phrase-matching in the production classifier; the FakeGateway mirrors it deterministically for
tests/offline):
- **Routine maintenance** ("service", "general servicing", "tune-up", "routine/regular maintenance",
  "basic service") → **TUNE_BASIC**. A clear routine request is **not** ambiguous for lack of a named
  fault → **no clarification**.
- **Explicit full/complete overhaul or rebuild** → **TUNE_FULL** (never for the mere word "service").
- **Diagnostic** — "inspect", or a symptom the customer can't localize ("something feels wrong", "a noise
  I can't locate") → **GENERAL_INSPECT**.
- **Specific repair** → its specific catalog code (e.g. brake pads → BRAKE_PADS), never TUNE_BASIC by default.
- **Price-only inquiry** → `price_inquiry` (no work order). **Cancellation/change** → no new order and no
  auto-cancel (serviceCodes empty; a person follows up).
- **True clarification** only when no allowed code applies and intent is genuinely unclear (≤1 question, I6).

The code contract is unchanged: catalog remains the only price source (I5), schema+catalog validation (I3),
one-question policy (I6), `decide()` still owns the outcome. Unknown bike type / date are represented as
absent (dateWords null) — never fabricated, never a clarification trigger. **Verified live:** "general
servicing" → TUNE_BASIC, `ordered`, zero clarification emails. **Door:** two-way (prompt + fake, no schema
change). See `specs/003-ai-pipeline/`.
