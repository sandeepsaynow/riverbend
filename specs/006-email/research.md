# Feature 006 — Research: Resend as the sole email provider (amendment, 2026-11-04)

Supersedes the Mailpit/SMTP transport of the original 006 (kept for provenance). All provider facts
below were verified against the official Resend docs on 2026-11-04 (source URLs inline). We do **not**
invent SDK methods, fields, headers, endpoints, or CLI arguments; anything undocumented is flagged.

## Decision summary (→ D21)
- **Outbound** uses the official `resend` Node SDK. **Inbound** uses Resend's `email.received` webhook
  (Svix-signed) + the Receiving API to fetch full content. Mailpit/SMTP/nodemailer are removed.
- Riverbend's business logic is preserved unchanged: transactional `email_outbox` (one per request),
  signed `reply+<token>@` correlation (`tokens.ts`), Message-ID de-dup, one-round enforcement,
  failed-send → `needs_review`, forced RLS tenant isolation, pg-boss/reconciler durability.

## 1. SDK + versions
- Package **`resend`**, latest stable **6.37.0** (`npm view resend`), `engines.node >=20` — compatible
  with our Node ≥22, ESM `import { Resend } from 'resend'`. Source: resend.com/docs/send-with-nodejs,
  github.com/resend/resend-node.
- Webhook signatures use **Svix**; verify with the **`svix`** package (`new Webhook(secret).verify`)
  or `resend.webhooks.verify`. Source: resend.com/docs/webhooks/verify-webhooks-requests.

## 2. Outbound send
```ts
const { data, error } = await resend.emails.send(
  { from, to, subject, html, text, replyTo, headers },   // replyTo is camelCase in the SDK
  { idempotencyKey },                                      // 2nd arg
);
// success → { data: { id }, error: null }; failure → { data: null, error: { name, message } }
```
- The SDK **returns `{data,error}` and does not throw** for API errors; `try/catch` only catches
  network faults. Message id is **`data.id`**. Source: send-with-nodejs, send-with-express.
- **Idempotency:** `idempotencyKey` (≤256 chars) dedupes identical sends for **24h**. We use
  `rb-followup-<request_id>` so job retries never send two clarification emails. Source:
  dashboard/emails/idempotency-keys.
- **Rate limit:** 10 req/s per team → HTTP 429 with `retry-after`. Mitigate by the reconciler's small
  batch + bounded backoff. Source: api-reference/rate-limit.

## 3. Inbound (`email.received`)
- The **webhook payload is metadata only** — "Webhooks do not include the email body, headers, or
  attachments, only their metadata." `data` has `email_id`, `from`, `to[]`, `subject`, `message_id`,
  `received_for[]`, attachment metadata. Source: webhooks/emails/received, dashboard/receiving/*.
- Fetch full content: **`GET /emails/receiving/{id}`** → SDK **`resend.emails.receiving.get(email_id)`**
  → `{ to[], from, subject, html, text, headers, reply_to[], message_id, authentication{spf,dkim,dmarc},
  raw{download_url}, attachments[] }`. Source: api-reference/emails/retrieve-received-email,
  dashboard/receiving/get-email-content.
- **Trust:** the retrieved email carries `authentication` (SPF/DKIM/DMARC verdicts). We never trust the
  `from` header alone — correlation is by the **signed** `reply+<token>@` token (binds shop+request),
  plus Message-ID de-dup, plus the `awaiting_customer` one-round guard. (DMARC/SPF verdicts are recorded
  for observability; the signed token is the authority.)

## 4. Webhook verification (Svix)
- Headers: **`svix-id`, `svix-timestamp`, `svix-signature`**. Verify against the **raw request body**
  (parsing+re-stringifying breaks the signature). `verify` **throws on invalid** → return 400.
- Express 5 note (not in docs, a consequence of the raw-body rule): `express.json()` consumes the body,
  so the webhook route must verify over captured raw bytes. We already stash `req.rawBody` via the
  `express.json({ verify })` hook in `src/api/app.ts`; the Resend route uses that buffer.
- **Retries/replays:** failed deliveries retry 8× with backoff; **the same `svix-id` is reused**, so we
  de-dup durable ingestion by `svix-id`. Source: webhooks/retries-and-replays, webhooks/event-types.

## 5. Event types
Confirmed: `email.sent`, `email.delivered`, `email.bounced`, `email.failed`, `email.delivery_delayed`,
`email.received` (also `.complained/.opened/.clicked/.scheduled/.suppressed`). We subscribe the first
six. We do **not** use the separate `inbox.*` family. Delivery-event payloads beyond `received` are not
field-documented on the index page; we read only `type` + the email id/`message_id` we already persisted
and treat unknown shapes defensively. Source: webhooks/event-types.

## 6. Local dev + domain-free testing
- CLI **`resend-cli`**: `resend webhooks listen --url <public-url> --forward-to http://localhost:PORT
  --events email.received email.delivered ...`. **No built-in tunnel** — supply a public URL (ngrok /
  Tailscale Funnel). Source: resend.com/docs/cli.
- **Domain-free inbound:** every account has a Resend-managed receiving subdomain `<id>.resend.app`;
  mail to **any** address there is received → real `email.received`. So `reply+<token>@<id>.resend.app`
  works for inbound testing without owning a domain. Source: dashboard/receiving/introduction.
- **Domain-free outbound is restricted:** before verifying a domain you send `from` `onboarding@resend.dev`
  and may send **only to your own account email** (others → 403); test-outcome recipients
  `delivered@/bounced@/complained@resend.dev` simulate states; `@example.com` → 422. Source:
  knowledge-base/what-email-addresses-to-use-for-testing, 403-error-resend-dev-domain.

## 7. Production domain + DNS
- Sending: add the SPF (TXT + MX on a `send` subdomain) and DKIM (TXT/CNAME) records exactly as the
  dashboard shows; DMARC added after verification. Receiving: add the **MX** record from the dashboard
  with the **lowest priority** (use a subdomain like `inbound.riverbend.example` if the root already has
  MX). GCP blocks port 25, so a provider (Resend) is required — matches the original D10 rationale.
  Source: add-a-domain, dashboard/receiving/custom-domains.

## 8. What this means for tests (no live credentials)
- Outbound: a fake Resend client returning `{data:{id},error:null}` / `{data:null,error}` drives
  success, permanent-failure, and transient-retry paths deterministically.
- Inbound: **real `svix` signing** of fixtures (same library prod verifies with) proves signature
  verification; a fake receiving client returns canned `{text,html,to,message_id}` so correlation,
  de-dup, one-round, and quote-stripping are asserted without any network call.
- Mocked SDK tests are labelled **deterministic integration**, never evidence of real delivery (Phase K).

## Polling-mode extension (D21.1 — local/MVP inbound by Resend API polling, 2026-11-04)
Verified against installed `resend@6.37.0` TS defs + docs (api-reference/emails/list-received-emails):
- **`resend.emails.receiving.list({ limit?, after?, before? })`** → `{ data: { object:'list', has_more:boolean,
  data: ListReceivingEmail[] }, error }`. `ListReceivingEmail` = the GET shape **without** `html/text/headers/
  raw/object` — i.e. it carries `id, to[], from, created_at, subject, bcc, cc, reply_to, received_for[],
  message_id, attachments[]`. `limit` 1–100 (omit → all in one response). `after`/`before` take an **email id**
  (exclusive); mutually exclusive.
- **Ordering, retention, and a per-endpoint rate limit are NOT stated** in the docs. Consequences for us:
  - Ordering unknown → we do **not** rely on it. **De-dup by the received email `id`** (via `email_events`,
    unique) is the source of truth: each email is fetched + correlated exactly once regardless of order.
  - We still persist a durable high-water (`email_poll_state.last_created_at` + `last_email_id`) and bound
    each tick to `maxPages` × `limit`; the scan overlaps and dedups rather than trusting a strict cursor.
  - Retention unknown → **assumption:** recently received emails remain listable; at a 60s default interval
    this is safe for a dev/MVP reviewer. If an email aged out of the list before any poll it would be missed
    — production should prefer webhooks (lower latency, push-delivered). Documented, not fabricated.
- Content is still fetched with `resend.emails.receiving.get(id)` (unchanged); general API rate limit is
  10 req/s per team → 429 (earlier research), so a tick makes 1 list/page + 1 get/new-email, bounded.
- The official **`resend-cli`** is NOT needed in polling mode (no public URL / webhook / tunnel).

## Live-provider finding (D21.2, 2026-11-04) — reply-to local-part length
Verified against the real Resend API with a live key: a send whose `reply_to` is `reply+<token>@…` with a
**142-char local part** (the old string-encoded token: base64url("shopId:requestId") + "." + base64url(HMAC))
is rejected **HTTP 422** (validation). A short local part (~25 chars) is accepted (200). Root cause: RFC 5321
caps an email local part at **64 chars**; the old token blew past it, so every real clarification failed to
send and parked the request `needs_review` (`email_delivery_failed`). **Fix:** pack the two UUIDs as raw
bytes (16+16) + a 10-byte truncated HMAC into one base64url blob — 42 bytes → 56 chars → `reply+<token>@`
local part = **62 chars** (≤64). Same signed-correlation security (80-bit MAC + one-round/awaiting/Message-ID
gates). `mintReplyToken`/`readReplyToken` keep their signatures; no other code or test changed.
