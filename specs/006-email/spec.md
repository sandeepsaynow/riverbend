# Feature 006 — Email (lean spec)

> **AMENDMENT 2026-11-04 (D21): Resend is the sole email provider.** Mailpit/SMTP/nodemailer are
> removed. Outbound uses the official `resend` SDK; inbound uses Resend's Svix-signed `email.received`
> webhook + the Receiving API to fetch full content; delivery/bounce events update send status. All
> business logic below is **preserved** (outbox, signed `reply+<token>@` correlation, Message-ID
> de-dup, one round, failed-send → `needs_review`, forced-RLS isolation). The original Mailpit text is
> kept for provenance but is superseded. New/changed requirements are **FR-008…FR-014** at the end; see
> `research.md`, `plan.md`, `data-model.md`, `contracts/resend-webhook.md`, `tasks.md`, `quickstart.md`.

**Input**: D10 → **D21**. Outbound clarification questions and inbound reply resumption over email, via
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
