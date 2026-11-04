# Feature 006 — Data model (Resend amendment, D21)

Migration `11000_resend_email.cjs` (additive; `7000_email.cjs` unchanged).

## `email_outbox` — added columns (shop-owned, forced RLS as before)
| Column | Type | Notes |
|---|---|---|
| `html` | text NULL | sanitised HTML body sent alongside `body` (plain text). |
| `idempotency_key` | text NULL | stable `rb-followup-<request_id>`; provider dedupes 24h. |
| `attempts` | int NOT NULL DEFAULT 0 | send attempts (bounded retry). |
| `next_attempt_at` | timestamptz NULL | earliest next relay; backoff after a transient failure. |
| `delivery_status` | text NULL | NULL→`accepted`(API ok)→`sent`→`delivered`/`bounced`/`failed`/`delayed` (from events). |
| `delivered_at` | timestamptz NULL | set on `email.delivered`. |
| `failure_reason` | text NULL | short, no PII. |

`status` (pending|sent|failed) is unchanged; `delivery_status` tracks provider lifecycle after our send
succeeds. `relayPending` selects `status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now())`.
Monotonic status rule: a later `delivered`/`bounced` never regresses to `sent`; duplicate events are no-ops.

## `email_events` — NEW (global provider-ingestion log; no shop_id, no PII; not under tenant RLS)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `svix_id` | text NOT NULL UNIQUE | provider delivery id; **de-dup key** (same id on retries). |
| `event_type` | text NOT NULL | `email.received`/`sent`/`delivered`/`bounced`/`failed`/`delivery_delayed`. |
| `resend_email_id` | text NULL | `data.email_id`/`data.id`; correlates to `email_outbox.provider_message_id` or the received message to fetch. |
| `status` | text NOT NULL DEFAULT 'pending' | `pending`→`processed`/`ignored`/`error`. |
| `attempts` | int NOT NULL DEFAULT 0 | worker processing attempts (bounded). |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `processed_at` | timestamptz NULL | |
| `detail` | text NULL | short processing outcome, no PII. |

Rationale for global (no `shop_id`): the event arrives **before** correlation — the owning shop is only
known after fetching + verifying the signed token. Storing no address/subject/body keeps VII (privacy)
and means the shop_id-forced-RLS policy-check does not apply (same deviation class as the Better-Auth
identity tables, D20). Grants: `app_admin` only (worker uses the admin connection, as the relay already does).

## Unchanged
`inbound_emails` (per-shop Message-ID de-dup) and `follow_ups.reply_content/replied_at` are reused as-is.
`job_outbox` resumption is unchanged (received reply → insert job → pg-boss → pipeline `extract-reply`).
