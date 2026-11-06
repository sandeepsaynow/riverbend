# Feature 006 — Email (lean spec)

> **AMENDMENT 2026-11-04 (D21): Resend is the sole email provider.** Mailpit/SMTP/nodemailer are
> removed. Outbound uses the official `resend` SDK; inbound uses Resend's Svix-signed `email.received`
> webhook + the Receiving API to fetch full content; delivery/bounce events update send status. All
> business logic below is **preserved** (outbox, signed `reply+<token>@` correlation, Message-ID
> de-dup, one round, failed-send → `needs_review`, forced-RLS isolation). The original Mailpit text is
> kept for provenance but is superseded. New/changed requirements are **FR-008…FR-014** at the end; see
> `research.md`, `plan.md`, `data-model.md`, `contracts/resend-webhook.md`, `tasks.md`, `quickstart.md`.

> **AMENDMENT 2026-11-06 (D25): new inbound email → new request.** Until now inbound handled only *replies*.
> Now a brand-NEW email (no reply token) creates a new request, attributed to the shop that owns the
> **verified destination address** (`shops.inbound_address`, migration `13000`), never the sender (FR-013).
> Unknown/ambiguous recipients are safely ignored; idempotency is the provider Message-ID via IntakeService.
> Reply-resume (US2) is unchanged and takes precedence when a `reply+<token>` address is present. New
> requirements **FR-015…FR-017** below; see `data-model.md` (`shops.inbound_address`) and `tasks.md` Phase 8.

**Input**: D10 → **D21** → **D25**. Outbound clarification questions and inbound reply resumption over email, via
**Resend** (local dev uses Resend's managed receiving address + the `resend` CLI listener; the original
Mailpit sink is retired). Email is a side effect owned by **code**, behind an `EmailTransport` port
(Principle IV). Reuses the one-follow-up rule (I6) and the 003 reply-resumption path.

## User stories
- **US1 (P1) Ask one question by email.** When the pipeline needs a clarification (`awaiting_customer`),
  the shop's customer receives one email with the question and a reply-to that correlates their answer.
- **US2 (P1) Resume on reply.** A customer reply is correlated to the right request, de-duplicated, and
  resumes the pipeline (consuming the reply) — exactly once per request (one round).
- **US3 (P2) Delivery is honest.** A failed send parks the request in `needs_review` (never lost, never
  rolled back); duplicate or unmatched inbound mail is ignored safely.

## Functional requirements
- **FR-001**: Outbound uses a **transactional outbox** (`email_outbox`, one row per request) relayed by
  the worker through `EmailTransport` (Mailpit SMTP adapter; in-memory fake offline). Success → `sent`
  with the provider Message-ID; failure → `failed` **and** the request → `needs_review`
  (`email_delivery_failed`). The order/work is never rolled back (D10/VI).
- **FR-002**: No customer email on file → `needs_review` (`no_reply_path`) (I8). Email addresses and
  message text are never logged (VII).
- **FR-003**: Inbound replies arrive via a **signed webhook** (`POST /webhooks/email`), authenticated by
  an HMAC signature over the raw body (`EMAIL_WEBHOOK_SECRET`); a bad signature → 401.
- **FR-004**: Reply correlation is by a signed `reply+<token>@<domain>` address (and `In-Reply-To`/
  `References`), the token binding (shop, request) with `EMAIL_SIGNING_KEY`. Forged/unknown → ignored.
- **FR-005**: Inbound is **de-duplicated** by provider Message-ID (`inbound_emails` unique per shop); a
  duplicate is a no-op. Quoted history is stripped; the first reply wins (one clarification round, I6).
- **FR-006**: A correlated reply records `reply_content` and enqueues resumption through the existing
  outbox → relay → pipeline path; the pipeline consumes the reply and charges it as a distinct call.
- **FR-007**: All of email is **off unless configured** (`EMAIL_SIGNING_KEY`; outbound only with
  `RESEND_API_KEY`; inbound webhook only with `RESEND_WEBHOOK_SECRET`) — the offline suite and keyless
  default run are unchanged (an in-memory no-op transport stands in).

## Amendment requirements (D21 — Resend sole provider)
- **FR-008 (outbound via Resend)**: `relayPending` sends through a `ResendTransport` using
  `resend.emails.send({ from, to, subject, text, html, replyTo, headers }, { idempotencyKey })`. The
  provider message id (`data.id`) is persisted. A sanitised HTML body is sent alongside plain text.
- **FR-009 (send idempotency)**: each outbox row carries a stable `idempotency_key`
  (`rb-followup-<request_id>`) so pg-boss/reconciler retries never send two clarification emails (I6);
  the provider dedupes identical sends for 24h and the `email_outbox` UNIQUE(request_id) dedupes forever.
- **FR-010 (bounded retry)**: transient send failures (network, 429, 5xx) keep the row `pending` with
  `attempts`+`next_attempt_at` (capped exponential backoff, max `EMAIL_MAX_SEND_ATTEMPTS`); permanent
  failures (e.g. invalid recipient) and exhausted retries → `failed` **and** request `needs_review`
  (`email_delivery_failed`). A worker crash never loses a send (the row stays durable/`pending`).
- **FR-011 (inbound webhook, Svix)**: inbound arrives at **`POST /webhooks/resend`**, authenticated by
  **Svix** signature (`svix-id`/`svix-timestamp`/`svix-signature`) over the **raw body** with
  `RESEND_WEBHOOK_SECRET`; invalid/missing signature → 400. The provider event identity (`svix-id`) is
  **persisted before** the 200 ACK and de-duplicated; the body is **not** assumed present in the payload.
- **FR-012 (durable async processing)**: the webhook only verifies + records the event + ACKs; the
  **worker** drains unprocessed events — for `email.received` it fetches full content via
  `resend.emails.receiving.get(email_id)` then runs existing correlation; retrying a failed event never
  duplicates work orders (de-dup by `svix-id` and by Message-ID, plus the `awaiting_customer` guard).
- **FR-013 (trust boundary)**: the `from` header is never trusted alone; correlation authority is the
  signed `reply+<token>@` token (binds shop+request). SPF/DKIM/DMARC verdicts from the Receiving API are
  recorded for observability. Cross-tenant reply injection and token replay are prevented by the signed
  token + per-shop Message-ID de-dup + one-round guard. Oversized bodies are bounded; attachments ignored.
- **FR-014 (delivery status)**: `email.sent/delivered/bounced/failed/delivery_delayed` events update the
  outbox row's `delivery_status` (correlated by provider id); duplicate/out-of-order events never corrupt
  status (monotonic transitions). A delivered-API-200 is **not** treated as delivered until a
  `delivered` event arrives. Status is surfaced in the staff request view (010) where present.

## Amendment requirements (D21.1 — inbound by Resend API polling; default local/MVP mode)
- **FR-015 (polling discovery)**: when `RESEND_POLLING_ENABLED` (default true) **and** `RESEND_API_KEY` are
  set, a **pg-boss scheduled, self-rescheduling singleton** job runs every `RESEND_POLL_INTERVAL_SECONDS`
  (default 60). Each tick lists received emails via `resend.emails.receiving.list` and **discovers** each
  email id into the existing `email_events` log; the existing `processPendingEvents` then fetches content
  (`receiving.get`) and runs the unchanged correlation. No webhook, public URL, or tunnel is required
  locally. The signed webhook (FR-011/FR-012) is preserved but **off unless `RESEND_WEBHOOK_SECRET` is set**.
- **FR-016 (pagination + bounded scan)**: paginate with `limit`/`after` across multiple pages (bounded by
  `maxPages`), handling more emails than a single page; results order is **unstated** so correctness never
  depends on it.
- **FR-017 (dedup + durable checkpoint)**: each discovered email's provider id is persisted (`email_events`
  unique) **before** the checkpoint advances; de-dup by that id makes rediscovery a no-op, so overlapping
  scans, partial pages, and restarts never duplicate work. A durable high-water (`email_poll_state`) bounds
  the scan. Message-ID de-dup + the `awaiting_customer` one-round guard remain the final correctness gates.
- **FR-018 (single-flight)**: a durable DB **lease** (`email_poll_state.claimed_until`) ensures only one
  poller runs at a time across instances; a second concurrent poller no-ops. The pg-boss singleton job is a
  second guard.
- **FR-019 (resilience)**: a list/API failure releases the lease **without** advancing the checkpoint and
  fails the tick; the next scheduled tick retries (bounded, interval-paced) — already-discovered ids stay
  durable and de-dup on retry. 429/provider errors/restarts/partial pages are all safe. Retention of
  received emails is **unstated by Resend**; at 60s this is safe for dev/MVP — production prefers webhooks.

## Invariants touched
- I6 one round (first reply wins + `awaiting_customer` guard), I8 reply path. Isolation (I1) preserved:
  all email tables are shop-owned under forced RLS; correlation is tenant-scoped by the signed token.

## Acceptance (zero external deps; in-memory transport)
- enqueue + relay → one `sent` email with a `reply+…@` reply-to; no email on file → `needs_review`;
  failed send → `needs_review`; signed inbound reply → correlated, quotes stripped, resumption enqueued;
  duplicate Message-ID → no-op; forged token → unmatched; reply to a non-waiting request → ignored;
  webhook rejects a bad signature (401) and accepts a signed one (200).

## New requirements (D25, 2026-11-06)
- **FR-015 New inbound → new request.** An inbound email with no valid reply token, addressed to a shop's
  verified `inbound_address`, creates a new `source='email'` request for that shop and enters the normal
  pipeline. Distinct from reply-resume (US2), which wins when a `reply+<token>` address is present.
- **FR-016 Trusted routing.** Tenant is resolved ONLY from the verified destination address (DB map), never
  the sender. Unknown or ambiguous (0 or >1 shops) recipients create nothing (safe ignore). An invalid/
  expired reply token fails safe (never a new order).
- **FR-017 Idempotency + normalization.** De-dup by provider Message-ID (`messages UNIQUE(shop_id,'email',
  submission_id)`); two distinct emails with identical bodies are two requests. Body = plain-text, with a
  best-effort HTML→text fallback; empty bodies dropped; attachments skipped.

## New requirements (D30, 2026-11-06) — any-sender intake + reply safety

> **AMENDMENT 2026-11-06 (D30): verified live.** Shops are provisioned with real receiving addresses on the
> managed Resend domain `karoiechou.resend.app`; a real customer email (Gmail → Resend → poll → gpt-5.4-mini)
> was processed end-to-end into a `FLAT_FIX + CHAIN_REPLACE` work order. Routing is by the **trusted recipient
> address only** (never the body — the test email said "to Downtown" but that text is not used for routing).

- **FR-018 Any sender.** An email from ANY sender address is accepted; the sender (`from`) is recorded only as
  the reply path, never used for routing or authorization (FR-013 reaffirmed). Routing is the verified
  recipient address → `shops.inbound_address` (unique, case-insensitive).
- **FR-019 Receiving addresses.** Each shop has a distinct address on the account's managed receiving domain,
  e.g. `rb-downtown@karoiechou.resend.app`, `rb-northside@…`, `rb-lakeshore@…`. Provision with
  `RESEND_INBOUND_DOMAIN` (falls back to `RESEND_REPLY_DOMAIN`).
- **FR-020 Reply safety (no loops).** Before sending any automated reply (clarification/answer), the recipient
  is checked by `isNoReplyOrAuto`: a no-reply / bounce / system / mailing-list sender (`no-reply@`,
  `mailer-daemon@`, `postmaster@`, `bounces@`, `notifications@`, `listserv@`, …) or an empty sender → the reply
  is **suppressed** and the request is parked `needs_review` (`auto_reply_suppressed`), never emailed. Replies
  remain bounded to at most one per request (one-round guard + `email_outbox UNIQUE(request_id)`), which also
  prevents mail loops. Header-based auto-detection (`Auto-Submitted`, `List-*`, `Precedence: bulk`) is a
  documented future enhancement; the sender-address guard covers the common loop/bounce vectors today.
- **FR-021 Single poller.** The Resend receiving inbox is account-wide, so only ONE environment should poll it
  (local and GCP share the account). For a controlled test, disable the other (`RESEND_POLLING_ENABLED=false`).

## New requirements (D31, 2026-11-06) — source-aware tenant routing

> **AMENDMENT 2026-11-06 (D31).** Routing is source-aware and the **LLM never assigns `tenant_id`** — code
> resolves the tenant deterministically after validating against the three configured shops.

- **FR-022 Web origin is authoritative.** A web-form request belongs to the shop whose form it came through,
  regardless of shop names in the text. If the text addresses a DIFFERENT shop (deterministic mismatch guard),
  the request is **not** moved and **no** work order is created: on the first pass the customer is emailed a
  confirmation question and the request is parked `awaiting_customer` (pending). A second unresolved round, or
  any non-web channel, → `needs_review` (`wrong_shop_suspected`) for an authorized transfer or a new request.
  Tenants are never silently moved.
- **FR-023 Email shop resolution (recipient first, then content).** A **shop-specific** recipient address
  (`rb-downtown@…`) is authoritative — the body is never used for routing (FR-013). A **generic** recipient
  (maps to no shop, e.g. a catch-all/account address) is routed by `ShopsService.resolveShopByContent`, which
  returns every shop named as a whole word in the body; the worker routes **only when exactly one** shop
  matches. Example: a generic email saying "flat tire repaired at Northside" → Northside. The match is in
  CODE (regex word-boundary against the shop slug/display-name), validated against the three shops; the LLM is
  used for service extraction only, never to pick the tenant.
- **FR-024 Missing/ambiguous shop.** A generic email naming zero or more-than-one shop is **safely parked**
  (`unmatched`) — never guessed, never attributed cross-tenant. (Auto-asking a shop-clarification for a fully
  unrouted email, and resuming on reply, needs a no-tenant outbound path and is a documented future
  enhancement; today such mail is parked for human triage rather than dropped.)
- **FR-025 Established tenant sticks.** A reply correlated by a signed `reply+<token>` retains its original
  shop; content never re-routes an existing conversation. Idempotency (Message-ID), duplicate protection,
  per-shop LiteLLM budgets, reply-safety (FR-020) and RLS are all preserved; routing resolution uses the
  cross-tenant admin read only to pick the shop, then intake runs tenant-scoped under it.
