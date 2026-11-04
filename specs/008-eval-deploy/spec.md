# Feature 008 — Evaluation + Deployment (lean spec, reconstructed 2026-11-04)

**Reconstruction note:** Feature 008 was implemented (commits `700cb69`, `b6d1903`) but its spec file was
never committed. This document is reconstructed from the **actual implemented code + artifacts** (eval
harness, results, Terraform) and the original brief Part 7. It records what exists; it invents no
verification results.

**Input**: Part 7 — an evaluation of the brief's 40 sample messages, and a GCP deployment path as IaC.

## User stories
- **US1 (P1) Evaluate the 40 messages.** Replay the brief's 40 sample deliveries through the real
  pipeline and produce a results table (outcome, services, total, AI cost, latency) without fabrication.
- **US2 (P1) Deterministic + live modes.** A free deterministic run (CI-safe) and a gated real-provider
  run under a spend cap.
- **US3 (P2) Deployment path.** GCP infrastructure as validated Terraform; no live deploy.

## Functional requirements (as built)
- **FR-001**: `eval/messages.json` holds the brief's 40 sample messages verbatim (incl. the m-1003
  duplicate at #14 and the m-1024 injection line). **FR-002**: `eval/run.ts` replays them through the
  real `IntakeService` → `PipelineService` → `OrdersService`, reading outcomes back from the DB.
- **FR-003**: `make eval` (recorded/deterministic, golden extraction per message, free) writes
  `docs/results.md`; `make eval-live` (real OpenAI via the LiteLLM proxy, per-shop virtual keys) writes
  `docs/results-live.md` — kept separate so the deterministic run is never overwritten. A cumulative
  **spend guard** aborts well under the proxy's aggregate cap; costs are LiteLLM-calculated, not faked.
- **FR-004**: Results are read from the database after a real run; the 8 tricky cases are reported with
  their actual outcomes, and real-vs-golden divergences are surfaced honestly (not hidden).
- **FR-005**: `infra/terraform/` provisions the deploy target (Cloud Run api/worker/litellm, Cloud SQL
  HA+PITR, Secret Manager, Artifact Registry, external HTTPS LB + Cloud Armor, Workload Identity
  Federation). `terraform validate` passes (v1.17.1); **no `apply`** (blocker B2). CI runs
  fmt/validate/plan.
- **FR-006**: README records honest hours (owner TODO), the not-built list, and "what breaks first at
  100 shops"; the 2-page architecture note exists (`docs/ARCHITECTURE_NOTE.md`).

## Invariants touched
I5 (catalog pricing shown in results), I4 (spend reported in micros), IX (honesty — real vs mocked
clearly separated; no fabricated costs). 

## Acceptance (as achieved)
`make eval` → `docs/results.md` (40 messages, deterministic); `make eval-live` → `docs/results-live.md`
(real OpenAI, total spend ≈ $0.004, within guard); `terraform validate` → valid; the real run exposed
and then fixed the m-1025/m-1009/m-1032 product defects (Feature correctness guards, commit `a77fc3e`).
