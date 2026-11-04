# Checklist — 006 Resend email security & requirements quality (D21)

Reviewer-owned. `[x]` = the reviewer judged the requirement well-specified (not that code is done).
`/speckit-implement` reads but does not toggle these.

## Webhook trust
- [ ] CHK001 Is Svix signature verification required over the RAW body, with missing/invalid → 400? [Spec FR-011]
- [ ] CHK002 Is the provider event identity (`svix-id`) persisted BEFORE the 200 ACK and de-duplicated? [FR-011/FR-012]
- [ ] CHK003 Is it specified that the webhook payload is metadata-only and content must be fetched via API? [FR-012, research §3]
- [ ] CHK004 Is the `from` header explicitly NOT trusted as sender proof (signed token is authority)? [FR-013]
- [ ] CHK005 Are cross-tenant reply injection and token replay prevention specified? [FR-013]

## Outbound integrity
- [ ] CHK006 Is send idempotency specified so retries never send two clarification emails? [FR-009, I6]
- [ ] CHK007 Are transient vs permanent failures distinguished with bounded retry + needs_review park? [FR-010]
- [ ] CHK008 Is "API 200 ≠ delivered" explicit (delivery only on the `delivered` event)? [FR-014]
- [ ] CHK009 Is duplicate/out-of-order delivery-event handling specified as monotonic/no-corrupt? [FR-014]

## Secrets & isolation
- [ ] CHK010 Are `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET` never logged, never in the browser, never tracked? [I7]
- [ ] CHK011 Is fail-closed gating specified (off unless the required keys are set)? [FR-007]
- [ ] CHK012 Is tenant isolation preserved (shop-owned outbox/inbound under forced RLS; `email_events` global, no PII)? [I1, data-model]
- [ ] CHK013 Are message sizes bounded and attachments ignored/rejected? [FR-013]

## Testing honesty
- [ ] CHK014 Are mocked-SDK tests labelled deterministic-integration, never evidence of real delivery? [research §8]
- [ ] CHK015 Is TEST C marked BLOCKED without a verified sending domain rather than fabricated? [quickstart]

## Polling mode (D21.1)
- [ ] CHK016 Is single-flight across instances specified (durable lease) so concurrent pollers can't double-process? [FR-018]
- [ ] CHK017 Is each discovered provider id persisted BEFORE the checkpoint advances, with dedup on rediscovery? [FR-017]
- [ ] CHK018 Are pagination + unstated ordering handled by dedup (not order-dependence)? [FR-016]
- [ ] CHK019 Is failure handling specified (release lease, no advance, bounded interval-paced retry; 429/restart/partial pages safe)? [FR-019]
- [ ] CHK020 Is the unstated retention assumption documented (webhooks preferred for production)? [FR-019, research]
- [ ] CHK021 Is provider-API integration testing distinguished from complete customer-email delivery testing? [quickstart]
