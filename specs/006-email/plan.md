# Feature 006 — Plan (Resend amendment, D21)

## Approach
Keep the existing module shape; swap the transport and inbound path to Resend. No new microservice, no
new frontend. The `EmailTransport` port, `EmailService` business logic, `tokens.ts`, `email_outbox` and
`inbound_emails` are **reused**; a new durable `email_events` ingestion table and delivery-status columns
are added.

## Components
- **`src/modules/email/transport.ts`** — keep `EmailTransport` port + `InMemoryEmailTransport`; add
  optional `html` + `idempotencyKey` to `OutboundEmail`; **replace** `MailpitTransport` with
  **`ResendTransport`** (`resend` SDK, `{data,error}` handling, classifies transient vs permanent via a
  thrown typed error so `relayPending` can retry vs park).
- **`src/modules/email/resend-webhook.ts`** (new) — `InboundWebhookVerifier` port + `SvixVerifier`
  (prod, `svix`) so `EmailService`/routes don't hard-depend on svix and tests can sign real fixtures.
- **`src/modules/email/receiving.ts`** (new) — `ReceivingClient` port (`get(emailId)`) + `ResendReceiving`
  (SDK `emails.receiving.get`); tests inject a fake.
- **`src/modules/email/index.ts`** — add `ingestEvent(...)` (durable, dedup by svix-id, before ACK),
  `processPendingEvents(receiving)` (worker drain: received → fetch+correlate; delivery → status),
  `applyDeliveryStatus(...)`; keep `enqueueFollowUp`, `relayPending` (now with retry/backoff + html),
  `handleInbound` (now fed fetched content), `stripQuoted`.
- **`src/api/resend-webhook.ts`** (new, replaces `email-webhook.ts`) — `POST /webhooks/resend`: Svix
  verify over `req.rawBody` → `ingestEvent` → 200. No provider/network call in the api process.
- **`src/platform/config/index.ts`** — add `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM`,
  `RESEND_REPLY_DOMAIN`, `EMAIL_MAX_SEND_ATTEMPTS`; remove `EMAIL_WEBHOOK_SECRET`, `MAIL_SMTP_HOST`,
  `MAIL_SMTP_PORT`, `MAIL_FROM`, `MAIL_REPLY_DOMAIN`.
- **`src/api/server.ts` / `src/worker/index.ts`** — build `ResendTransport`/`ReceivingClient` when
  `RESEND_API_KEY` is set (else in-memory no-op, keyless default); mount the webhook when
  `EMAIL_SIGNING_KEY` + `RESEND_WEBHOOK_SECRET`; the worker reconciler also drains `email_events`.
- **Migration `11000_resend_email.cjs`** (new; `7000_email.cjs` is untouched history) — ALTER
  `email_outbox` (+html, idempotency_key, attempts, next_attempt_at, delivery_status, delivered_at,
  failure_reason); CREATE `email_events` (global provider-ingestion log, dedup by svix-id, no shop_id,
  no body/PII — mirrors the D20 "global system table, not under tenant RLS" precedent).

## Removal (Phase I)
Delete the `mailpit` compose service + worker `MAIL_SMTP_*`; drop `nodemailer`/`@types/nodemailer`;
remove `MailpitTransport` + `src/api/email-webhook.ts`; reconcile `.env.example`, Makefile, README,
Terraform secret names, CI. Historical docs may still mention Mailpit as superseded.

## Constitution check
- I1 isolation: `email_outbox`/`inbound_emails` stay shop-owned + forced RLS; `email_events` is a global
  provider log with **no** `shop_id` and no PII (so the shop_id-RLS policy-check does not apply — same
  class as the Better-Auth tables, D20). Correlation is tenant-scoped via the signed token.
- I6 one round: idempotency key + UNIQUE(request_id) + `awaiting_customer` guard + first-reply-wins.
- I7 secrets: `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET` never logged, never in the browser, never tracked.
- I8 reply path: no email on file → `needs_review` (`no_reply_path`) unchanged. Fail-closed throughout.

## Testing (Phase J, no credentials)
Rewrite `tests/integration/email.test.ts` + add `tests/integration/resend-webhook.test.ts`: fake Resend
send client (success/permanent/transient), real `svix` signing for webhook fixtures, fake receiving
client. Assert outbound send + idempotency + retry/park, Svix valid/invalid/missing, raw-body
verification, duplicate event (same svix-id) no-op, inbound fetch+correlate, wrong-shop/forged token
rejected, one-question + duplicate-reply handling, delivery/bounce status transitions, no secret
disclosure, RLS isolation intact, and the LiteLLM/orders regressions stay green.
