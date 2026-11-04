# Feature 006 — Tasks (Resend amendment, D21)

Status key: [x] done+verified · [~] scaffolded/not fully verified · [ ] not started.
Original 006 (Mailpit) shipped under commit history; these tasks cover the Resend migration only.

## Phase 0 — Library + schema
- [x] T001 Add `resend@6.37.0` + `svix` to dependencies; remove `nodemailer` + `@types/nodemailer`.
- [x] T002 Migration `11000_resend_email.cjs`: ALTER `email_outbox` (+html, idempotency_key, attempts,
      next_attempt_at, delivery_status, delivered_at, failure_reason); CREATE `email_events` (global, dedup svix_id).
- [x] T003 Config: add `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM`, `RESEND_REPLY_DOMAIN`,
      `EMAIL_MAX_SEND_ATTEMPTS`; remove `EMAIL_WEBHOOK_SECRET`, `MAIL_SMTP_HOST/PORT`, `MAIL_FROM`, `MAIL_REPLY_DOMAIN`.

## Phase 1 — Outbound (Resend SDK)
- [x] T010 `OutboundEmail` + `html`/`idempotencyKey`; `ResendTransport` (SDK, {data,error}, typed
      Transient/PermanentSendError); remove `MailpitTransport`.
- [x] T011 `EmailService.enqueueFollowUp` sets `idempotency_key` + a sanitised `html`; `relayPending`
      adds bounded retry/backoff (keep pending on transient; park needs_review on permanent/exhausted).

## Phase 2 — Inbound (Svix webhook + Receiving API + delivery events)
- [x] T020 `InboundWebhookVerifier` port + `SvixVerifier`; `ReceivingClient` port + `ResendReceiving`.
- [x] T021 `EmailService.ingestEvent` (durable, dedup svix_id, before ACK) + `processPendingEvents` +
      `applyDeliveryStatus` (monotonic); `handleInbound` fed fetched content.
- [x] T022 `POST /webhooks/resend` (`src/api/resend-webhook.ts`): Svix verify over rawBody → ingest → 200;
      remove `src/api/email-webhook.ts`.

## Phase 3 — Wiring + removal
- [x] T030 `server.ts`/`worker/index.ts`: build Resend transport/receiving when `RESEND_API_KEY` set
      (else in-memory no-op); mount webhook when `EMAIL_SIGNING_KEY`+`RESEND_WEBHOOK_SECRET`; reconciler drains events.
- [x] T031 Remove Mailpit from docker-compose + worker SMTP env; reconcile `.env.example`, Makefile, README.
- [x] T032 Reconcile Terraform secret names (email-webhook-secret → resend-webhook-secret; +resend-api-key) + CI.

## Phase 4 — Tests (real PostgreSQL, no live credentials)
- [x] T040 Rewrite `tests/integration/email.test.ts`: outbound send + idempotency + transient-retry +
      permanent-park (fake Resend client); preserve no_reply_path + failed→needs_review assertions.
- [x] T041 `tests/integration/resend-webhook.test.ts`: real svix-signed fixture 200; bad/missing sig 400;
      duplicate svix-id no-op; received → fetch(fake)+correlate accepted; forged token unmatched;
      wrong-shop rejected; one-round; delivery/bounce status transitions; no secrets in responses.
- [x] T042 `npm run typecheck` · `npm run lint` · `npx vitest run` all green; `docker compose config` ok.

## Phase 5 — Docs + converge
- [x] T050 D21 in decision-log + ARCHITECTURE_DECISIONS (supersede D10); REQUIREMENTS, EDGE_CASES,
      IMPLEMENTATION_SLICES/PROGRESS, AUTONOMOUS_DECISIONS/HANDOFF, README, .env.example, quickstart.
- [x] T051 Re-run analyze/converge; commit locally (no push).
- [ ] T060 Real-provider verification (Phase K) — BLOCKED without `RESEND_API_KEY` + receiving address +
      webhook secret; record exact manual steps in quickstart. Do not fabricate.

## Phase 6 — Inbound polling (D21.1; default local/MVP)
- [x] T070 Migration `11100_email_poll.cjs`: `email_poll_state` singleton (checkpoint + lease), admin-only.
- [x] T071 Config: `RESEND_POLLING_ENABLED` (default true), `RESEND_POLL_INTERVAL_SECONDS` (default 60).
- [x] T072 `ReceivingLister` port + `ResendReceiving.list`; `EmailService.pollOnce` + `tryClaimPoll` (lease).
- [x] T073 pg-boss `workPoll`/`schedulePoll` (singleton, self-rescheduling) + `EMAIL_POLL_QUEUE`; wire the
      worker (pollOnce → processPendingEvents) behind `RESEND_POLLING_ENABLED` + `RESEND_API_KEY`.
- [x] T074 `tests/integration/email-poll.test.ts`: empty list, one reply (e2e), multiple pages, duplicate
      ids (dedup), retry-after-failure, worker restart, cursor persistence, concurrent pollers (lease),
      wrong-shop token, invalid token, unrelated email, duplicate Message-ID, one-question, resumption +
      work-order idempotency.
- [x] T075 typecheck + lint + full vitest + `docker compose config` green; docs reconciled (D21.1 in
      ARCH/decision-log/REQUIREMENTS/EDGE_CASES/PROGRESS/AUTONOMOUS_*/README/.env.example/quickstart/Makefile).

## Phase 7 — Live-provider acceptance (D21.2)
- [x] T080 Fix reply-to local-part length (>64 → Resend 422): compact binary token encoding in
      `tokens.ts` (two UUIDs as raw bytes + 10-byte HMAC, one base64url blob; 62-char local part). Correlation
      semantics + signatures unchanged; 21 email/webhook/poll tests still green.
- [x] T081 Live key validation (200), Receiving list+get schema match, live polling discovery+ignore of a
      real received email, outbound send to delivered@resend.dev (200 + id). Documented in FINAL_MANUAL_TEST.md.
- [ ] T082 Full real customer-reply resumption — BLOCKED-pending-user: requires replying from a real mailbox
      to a `reply+<token>@<RESEND_REPLY_DOMAIN>` address of a live awaiting request (steps in quickstart).
