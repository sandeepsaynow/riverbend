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
