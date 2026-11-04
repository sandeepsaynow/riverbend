# Contract — `POST /webhooks/resend` (D21)

Inbound Resend webhook for `email.*` events. Mounted OUTSIDE shop auth; authenticated by Svix signature.
Off unless `EMAIL_SIGNING_KEY` + `RESEND_WEBHOOK_SECRET` are set.

## Request
- Headers (required): `svix-id`, `svix-timestamp`, `svix-signature`.
- Body: JSON `{ type: "email.received"|"email.sent"|..., created_at, data: { email_id?, message_id?, ... } }`.
  Treated as **metadata only** — the body/headers of the customer email are NOT present and must be
  fetched via the Receiving API.
- Verification is over the **raw bytes** (`req.rawBody`), never the re-serialised JSON.

## Responses
| Case | Status | Body |
|---|---|---|
| Valid signature, new event | 200 | `{ "status": "accepted" }` (event persisted `pending`) |
| Valid signature, duplicate `svix-id` | 200 | `{ "status": "duplicate" }` (no-op) |
| Missing/invalid signature | 400 | `{ "error": "invalid signature" }` |
| Malformed event (no `svix-id`) | 400 | `{ "error": "malformed event" }` |

Always ACK 200 for a verified event even if downstream correlation will later ignore it (don't leak which
reply tokens exist). The worker performs the content fetch + correlation asynchronously and idempotently.

## Worker processing (drains `email_events` where `status='pending'`)
- `email.received`: `resend.emails.receiving.get(data.email_id)` → `{ to[], from, text, html, message_id,
  authentication }` → `handleInbound({ providerMessageId: message_id, toAddress: <reply+token@>, text })`.
  Outcomes: `accepted` | `duplicate` | `unmatched` | `ignored_not_awaiting` → event `processed`/`ignored`.
- `email.sent/delivered/bounced/failed/delivery_delayed`: `applyDeliveryStatus(resend_email_id, type)` →
  monotonic update of `email_outbox.delivery_status` (no regression; duplicates no-op).
- Transient fetch failure → leave `pending`, bump `attempts`, retry next tick (bounded); exhausted → `error`.

## Outbound send contract (`ResendTransport`)
`resend.emails.send({ from: RESEND_FROM, to, subject, text, html, replyTo: reply+<token>@RESEND_REPLY_DOMAIN,
headers }, { idempotencyKey: rb-followup-<request_id> })` → `{ data:{id}, error }`. `error` present →
classify: permanent (validation/invalid recipient) → throw `PermanentSendError`; transient (rate_limit/
server/network) → throw `TransientSendError`. `relayPending` maps permanent/exhausted → `failed` +
`needs_review`; transient → keep `pending` + backoff.
