# Feature 006 — Quickstart (Resend, D21)

## Offline (default — no Resend, no network)
`npx vitest run` and `make up` work with no email keys: outbound uses an in-memory no-op transport and
the webhook is unmounted. Nothing to configure.

## Local two-way with real Resend (domain-free)
Prereqs: a Resend account + API key, and a public URL for the webhook (ngrok / Tailscale Funnel — the
Resend CLI has no built-in tunnel).

1. **Dashboard setup (manual, one-time):**
   - Create an API key → `RESEND_API_KEY`.
   - Emails → **Receiving** tab → copy the managed receiving address domain `*.resend.app` →
     `RESEND_REPLY_DOMAIN=<id>.resend.app`.
   - Add a webhook for events `email.received email.sent email.delivered email.bounced email.failed
     email.delivery_delayed` pointed at `<public-url>/webhooks/resend` → copy its signing secret
     (`whsec_...`) → `RESEND_WEBHOOK_SECRET`.
   - Before verifying a domain, outbound may only go to **your own account email**; use
     `RESEND_FROM='Riverbend Cycles <onboarding@resend.dev>'`.
2. **.env (git-ignored):** set `EMAIL_SIGNING_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`,
   `RESEND_FROM`, `RESEND_REPLY_DOMAIN`. (No `MAIL_*` / `EMAIL_WEBHOOK_SECRET` anymore.)
3. **Run:** `docker compose --profile llm up` (real OpenAI + Resend), then start the listener:
   `resend webhooks listen --url <public-url> --forward-to http://localhost:8080 --events email.received email.delivered`.

### TEST A — real inbound (domain-free)
Send an email from your Gmail/Outlook to `reply+<anytoken>@<id>.resend.app`. Expect: a signed
`email.received` webhook → `email_events` row → worker fetches content → unmatched token is ignored
(no work order). Then exercise a real correlation via TEST C.

### TEST B — outbound sandbox
Trigger a clarification in-app; with `RESEND_FROM=onboarding@resend.dev` the send to the customer's
address is **restricted to your own account email** until a domain is verified. Use
`to=delivered@resend.dev`/`bounced@resend.dev` to observe delivery/bounce events. Record the recipient
restriction honestly.

### TEST C — complete two-way (needs a verified sending domain)
Customer submits an ambiguous request → OpenAI asks one question → Resend emails the customer → customer
replies → `email.received` → worker resumes → staff console shows the updated order. **BLOCKED** until a
sending domain is verified (SPF/DKIM) and `RESEND_FROM` uses it; mark BLOCKED, do not fabricate.

## Production
Verify a sending domain (SPF TXT+MX, DKIM) and, for your own receiving domain, add the Resend **MX**
record at lowest priority (prefer a subdomain, e.g. `inbound.riverbend.example`). GCP blocks port 25, so
Resend (HTTPS API + webhook) is required. Store all keys in Secret Manager (see Terraform).

## Default local inbound: Resend API polling (D21.1 — no public URL / webhook / tunnel)
Polling is ON by default; it activates when `RESEND_API_KEY` + `EMAIL_SIGNING_KEY` are set (and
`RESEND_POLLING_ENABLED` is not `false`). `RESEND_WEBHOOK_SECRET` is **not** needed in this mode.

1. **.env:** set `EMAIL_SIGNING_KEY`, `RESEND_API_KEY`, `RESEND_REPLY_DOMAIN` (your Resend-managed
   `<id>.resend.app` receiving domain), `RESEND_FROM`. Optional: `RESEND_POLL_INTERVAL_SECONDS` (default 60).
2. **Run:** `docker compose up` (or `make up`). The worker polls `emails.receiving.list` every 60s,
   discovers new emails, fetches their content, and resumes the matching request.
3. **Reviewer demo (how to send an email and have it processed):**
   - Trigger a clarification in-app (submit an ambiguous request via `/f/<shop>`), so the customer address
     receives `reply+<token>@<id>.resend.app`.
   - From any mailbox (Gmail/Outlook), send a reply **to that `reply+<token>@<id>.resend.app` address**
     (or reply to the clarification email). Within one poll interval the worker lists it, fetches content,
     correlates by the signed token, strips quotes, records the reply, and resumes the pipeline — visible in
     the staff console. Unrelated / forged-token emails create no work order.
4. This exercises the **real Resend provider API** (list + retrieve) end to end. It is **provider-API
   integration testing**, distinct from **complete customer-email delivery testing** (TEST C), which still
   requires a verified sending domain so outbound reaches arbitrary customer inboxes.

### Optional: production webhooks (lower latency)
Set `RESEND_WEBHOOK_SECRET` + configure the dashboard webhook (`POST <public-url>/webhooks/resend`) as in
the sections above. Webhooks push `email.received` immediately (no 60s poll delay). Polling and webhooks may
run together; Message-ID de-dup guarantees a single work effect. **Retention caveat:** Resend does not
document how long received emails remain listable — polling recovers anything still listable at the next
tick, but a push webhook is the stronger guarantee for production.

> **D21.2 (live fix):** the `reply+<token>@` local part is now 62 chars (compact binary token) so
> strict providers accept it — the old string token was ~142 chars and Resend rejected it HTTP 422.
