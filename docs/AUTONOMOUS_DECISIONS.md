# Autonomous Decision Log — Riverbend

Running log of decisions made while completing slices autonomously. Newest first within each feature.
Format: stage · ambiguity · options · decision + rationale · artifacts · tests · risks/deferred.

> Source priority: (1) take-home brief PDF, (2) constitution v1.1.0, (3) REQUIREMENTS.md + ARCHITECTURE_DECISIONS.md, (4) IMPLEMENTATION_SLICES.md + EDGE_CASES.md, (5) existing specs/code. On conflict, brief + tenant-isolation/safety invariants win; conflicts are recorded here.

---

## Global blockers (external inputs required — cannot be fabricated)

- **B1 — Real LLM provider credentials (slice 003+).** The constitution (VIII) requires the final
  AI pipeline to demonstrate extraction through a *real, configured* model provider, and the brief
  requires a 40-sample run with real model spend (< USD 20). A provider key / LiteLLM endpoint /
  Vertex AI service account is a **secret + paid service** → per the mission's blocker policy I build
  the AI pipeline against a **controllable fake model server** (constitution explicitly permits fakes
  for deterministic tests), and leave the real-provider run + live 40-sample eval + cost report as a
  gated step requiring the user's credentials. Nothing is faked or claimed as real.
- **B2 — GCP account (slice 008).** Terraform + live deploy need a cloud account; the brief scores
  IaC + a written plan equally to a live deploy, so IaC/docs are produced, `terraform validate` is
  the only gate attempted, and no live deploy is performed.

These are the brief's own "optional/choose-your-provider" boundaries, not shortcuts.

---

## Feature 002 — intake-queue

- **Convergence (2026-11-03).** Result: **Converged.** All 36 tasks implemented; full suite 40/40
  green (13 intake + 27 from 001) on real PostgreSQL (Testcontainers); live end-to-end through real
  pg-boss verified via `make up` (202 → dedupe → 409 → worker `received → awaiting_pipeline`).
  Documented deviations (accepted, not defects):
  - **Relay latency**: the worker drains the outbox to pg-boss on `RECONCILER_INTERVAL_MS` (10 s), so
    processing begins within that window. FR-003's immediate `202` is satisfied; processing is async.
    Rationale: simplest correct design (no post-commit nudge); no message is ever lost. Tunable.
  - **pg-boss crash recovery** (lease expiration → retry) is verified from pg-boss 12.38.0's own
    maintenance SQL (research R5), not a wall-clock crash test; processor/relay/dead-letter/RLS logic
    is covered by real-PostgreSQL tests with a fake queue, and the real queue by the live `make up`.
- **M1 (analyze)**: pg-boss is the single retry authority; the reconciler never re-enqueues. Applied
  across spec/plan/research/data-model/quickstart/tasks.
- **Idempotency**: keyed only on `(shop, source, submission_id)`; never on content/email/session.
  Content fingerprint used solely for same-id conflict detection (409). Internal UUID PK per message.
