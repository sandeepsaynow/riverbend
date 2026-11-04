# Feature 006 — Email (lean spec)

**Input**: D10. Outbound clarification questions and inbound reply resumption over email, via local
Mailpit. Email is a side effect owned by **code**, behind an `EmailTransport` port (Principle IV).
Reuses the one-follow-up rule (I6) and the 003 reply-resumption path.

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
- **FR-007**: All of email is **off unless configured** (`EMAIL_SIGNING_KEY`; SMTP only with
  `MAIL_SMTP_HOST`) — the offline suite and keyless default run are unchanged.

## Invariants touched
- I6 one round (first reply wins + `awaiting_customer` guard), I8 reply path. Isolation (I1) preserved:
  all email tables are shop-owned under forced RLS; correlation is tenant-scoped by the signed token.

## Acceptance (zero external deps; in-memory transport)
- enqueue + relay → one `sent` email with a `reply+…@` reply-to; no email on file → `needs_review`;
  failed send → `needs_review`; signed inbound reply → correlated, quotes stripped, resumption enqueued;
  duplicate Message-ID → no-op; forged token → unmatched; reply to a non-waiting request → ignored;
  webhook rejects a bad signature (401) and accepts a signed one (200).
