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

**Why this reverses the original pick.** The original Hybrid chose a Postgres reserve-then-settle ledger
as authority because "LiteLLM alone" had four gaps: batched spend lag, rolling (not calendar) window,
unverified fail-open, and no safe replays/resume. **LiteLLM 1.106.6 resolves two** (reservation-based
budgets and fail-closed enforcement now exist); the other two are handled by design (Riverbend
administers the calendar reset; a request-scoped usage record preserves no-double-charge on redelivery).

**Migration & rollback.** Dual-path behind a flag (`BUDGET_AUTHORITY=litellm|legacy`). The legacy
`BudgetService` and its `llm_calls`/`shop_budgets` tables are **repurposed, not dropped** (usage/policy
reporting), so rollback = flip the flag. Native enforcement becomes sole authority **only after** the
FR-007 acceptance tests pass (zero-cost rejection/mocks; no paid budget-exhaustion runs). **Door:** the
financial *records* remain one-way (kept, never rewritten); the enforcement engine is now two-way behind
the flag. See `docs/decision-log.md` (2026-11-04) and Feature 003 FR-007/FR-008.

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
