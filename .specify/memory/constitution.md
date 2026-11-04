<!--
SYNC IMPACT REPORT (temporary; remove before committing the amended constitution)
Version change: 1.1.0 → 1.2.0
Bump rationale: MINOR — invariant I4's ENFORCEMENT MECHANISM and PROOF are redefined (custom
  reserve-then-settle ledger → LiteLLM-native team/virtual-key budgets, fail-closed) while its
  GUARANTEE ("AI spend never exceeds a shop's monthly cap") is unchanged. No principle or
  invariant guarantee is removed/redefined (not MAJOR); more than wording (not PATCH).
  Prior: 1.0.0 → 1.1.0 added invariant I8 and expanded VI/VIII/IX (retained below).
Modified principles:
  VI.   Failure Is Normal — added durable tracking to a terminal/actionable state, mandatory
        staff-review routing when the one clarification round cannot resolve ambiguity, and an
        explicit ban on silent discard or auto-invented billable repairs.
  VIII. Tests Prove the Risky Parts — fakes allowed for deterministic tests, but the final
        implementation MUST demonstrate real extraction through the configured model provider
        via the gateway.
  IX.   Honesty About Scope — the 40-message evaluation MUST report real outcomes, token usage,
        total provider spend and failures; simulated calls / invented replies labelled and
        separated; no fabricated costs or metrics.
Added invariant:
  I8 — Any request that may need asynchronous clarification has a valid, authorized reply path
       (mandatory web-form email; reliable email conversation correlation). Delivery channel and
       provider stay implementation decisions.
Modified invariant (1.2.0):
  I4 — enforcement moved to LiteLLM-native budgets (one team per shop, restricted virtual keys,
       fail-closed admission, proxy-calculated cost capture); the calendar-month reset is
       administered by Riverbend (business policy), and a request-scoped usage record (NOT a
       second reservation engine) prevents double-charge on redelivery. Guarantee unchanged.
       Written decision: D7 (updated). The legacy reserve-then-settle path is retained behind a
       flag for rollback until native enforcement passes acceptance tests (Feature 003 FR-007).
Principle II updated: invariant range I1–I7 → I1–I8 ("all eight invariants").
Added/removed sections: none (I8 added to the existing Invariants table).
Preserved unchanged: Principles I–V and VII; invariants I1–I7; all technical non-negotiables.
Implementation choices (Express, pg-boss, LiteLLM, Mailgun, Cloud Run) remain in
  docs/ARCHITECTURE_DECISIONS.md and are NOT hardcoded here.
Templates reviewed: plan-template.md reads the constitution at runtime (no hardcoded invariant
  count); spec/tasks/checklist templates unaffected. No template change required.
Follow-up TODOs:
  - TODO(ARCH_DECISIONS): docs/ARCHITECTURE_DECISIONS.md (~line 26) still says "The seven
    invariants"; update to eight and add I8 so the planning doc matches (governance: planning
    docs are corrected to the constitution, not the reverse).
  - TODO(EDGE_CASES): add an I8 reply-path reference in docs/EDGE_CASES.md (web-form
    missing-email rejection; email reply correlation — rows 7, 9, 10 already describe the behaviour).
Source of principles: docs/ARCHITECTURE_DECISIONS.md and the Architecture Guide (Prompt B1 / Table 82).
-->
# Riverbend Work-Order Intake Constitution

The permanent rulebook for the Riverbend Cycles multi-tenant work-order intake service.
Every later specification, plan, task list, and code change MUST be checked against it.
The service turns messy inbound customer messages (web form, email, JSON API) into
schema-validated work orders for a chain of bike shops, where an AI model only interprets
text into structure and code owns every decision, price, and side effect.

## Core Principles

### I. Code Owns Money and Decisions

The model's only job is to turn text into a validated structure. All prices, totals, status
changes, side effects (sending email, creating work orders, cancelling), and the choice of
which follow-up question to ask MUST be decided by code, never by the model. Money MUST be
stored and computed as integers (whole cents; AI spend as whole millionths of a dollar);
floating point for money is forbidden. The model MAY propose a follow-up question's wording
but MUST NOT directly send email or create a work order.
**Rationale:** correctness, testability, and prompt-injection resistance all depend on the
model being untrusted input, not an actor. Verified by pricing property tests, the m-1024
injection test, and the absence of any model-initiated side effect.

### II. Invariants Always Hold (NON-NEGOTIABLE)

Invariants I1–I8 (see *Invariants and Technical Constraints*) MUST hold at all times, and
each MUST have a test that proves it. A change that cannot preserve all eight invariants MUST
NOT merge.
**Rationale:** these are the irreducible safety and correctness guarantees of the system; a
named test per invariant is what turns a promise into a property.

### III. Database-Enforced Shop Isolation (NON-NEGOTIABLE)

Shop isolation MUST be enforced by the data store, not by application memory: a `tenant_id`
on every shop-owned row, composite foreign keys so a row can never reference another shop's
row, row-level security **enabled and forced**, and a non-owner application role with no
bypass. The shop id MUST come from the authenticated credential (API key or signed token),
never from the request body or URL. Isolation MUST be proven by tests that attack the data
store **directly as the application role**, not only through the application.
**Rationale:** a leak between shops cannot be un-leaked; it is the brief's most serious rule.
A forgotten filter in one query MUST NOT be able to break tenancy.

### IV. Ports and Adapters

The job queue, the AI gateway, and email MUST sit behind our own interfaces. Modules MUST
talk to one another only through public entry files, and no module may read another module's
tables. These boundaries MUST be enforced by a build-time tool, not by discipline alone.
**Rationale:** reversible (two-way-door) technology choices stay replaceable, and the monolith
cannot quietly decay into a tangle. Verified by `dependency-cruiser` in CI and contract tests
on each interface.

### V. One-Way and Two-Way Doors

Any decision that is hard to undo — tenancy model, data model, money representation,
idempotency keys, public API contracts — MUST have a short written decision recorded before
code is written. Reversible choices (queue library, AI gateway, email provider, tracing
backend, web framework, model) do NOT require that ceremony and MUST stay behind an interface.
**Rationale:** care is finite; spend it on the decisions that are expensive to reverse.

### VI. Failure Is Normal

Every outgoing call MUST have a timeout and bounded retries (with backoff and jitter), and
only one layer may retry a given call. Every failure MUST end in a defined state that a person
can see. **No accepted message is ever lost:** every accepted request MUST remain durably
tracked until it reaches a terminal or actionable state. When the single permitted clarification
round (I6) cannot resolve the ambiguity, the request MUST be routed to a visible staff-review
state — never silently discarded, and never resolved by automatically inventing a billable
repair. The customer MUST receive an immediate acknowledgement before any slow work begins.
**Rationale:** the model, the queue, and the network will misbehave; the brief scores how the
customer and the shop experience that. Verified by outage, cap, crash-replay,
staff-review-routing, and delivery-failure tests.

### VII. Privacy by Default

Message text and personal data MUST NOT be written to logs, and personal data MUST be redacted
from traces. Retention of stored prompts and answers MUST be configurable and bounded. No
secret may exist in any committed file; all settings come from the environment, and the
application MUST refuse to start if a required setting is missing.
**Rationale:** customers write real names, emails, phones, and addresses in free text; logged
or leaked data cannot be taken back. Verified by a log/trace scan, a startup-fails-without-a-
setting test, and gitleaks in CI.

### VIII. Tests Prove the Risky Parts

Isolation, uniqueness, and concurrency tests MUST run against a real PostgreSQL instance.
A controllable fake AI server MAY be used for deterministic failure and extraction tests, but
the final implementation MUST also demonstrate successful extraction through a real, configured
model provider — reached through the AI gateway defined in `docs/ARCHITECTURE_DECISIONS.md`,
not through fakes alone. Money correctness MUST be covered by property tests. Every test that
guards a risky area MUST state why it exists.
**Rationale:** mocks cannot prove row-level security, unique keys, or race conditions; those
are exactly the parts that fail when it matters, and a pipeline that has never run against a
real model has not been shown to work.

### IX. Honesty About Scope

The README MUST record the real hours spent, an explicit **not-built** list, and what breaks
first at 100 shops. Claims in the architecture note MUST be true of the code that was actually
built; anything designed-but-not-built MUST move to the not-built list. The 40-message
evaluation MUST report actual outcomes, input and output token usage, total LLM-provider spend,
and failures; any simulated model call or invented customer reply MUST be clearly labelled and
separated from real evaluation results. Costs and success metrics MUST NOT be fabricated.
**Rationale:** scope honesty is scored, and a defended cut is worth more than a half-built
feature. A finished smaller system beats a larger unfinished one; a results table is worth
nothing unless its numbers are real.

## Invariants and Technical Constraints

The eight invariants, each with the kind of test that proves it (Principles II, III, VIII):

| # | Invariant | Proof |
|---|-----------|-------|
| I1 | No request can read another shop's data. | Cross-shop attack tests as the application role (raw SQL **and** via API); a build check fails if any `tenant_id` table lacks a forced policy. |
| I2 | At most one work order per request and bike. | A unique key on (shop, request, bike number); a test asserting two bikes → two orders and a retry creates no duplicate. |
| I3 | No model output is saved unless it passed schema validation. | Invalid-output tests: bad JSON and unknown service codes are rejected, never persisted as a work order. |
| I4 | AI spend never exceeds a shop's monthly cap. | A concurrency test against the enforcing proxy (LiteLLM + its own PostgreSQL): N parallel calls on a shop's restricted virtual key, whose team budget fits K, succeed exactly K times; the rest are rejected **before reaching the provider** and the request parks `held_budget`. Enforcement is **fail-closed** — if budget state cannot be verified, real inference is refused into a recoverable state. The cap is a **calendar-month** policy administered by Riverbend and enforced by LiteLLM at admission; a request-scoped usage record (not a second reservation engine) prevents a redelivered job from charging twice. The legacy reserve-then-settle ledger remains behind a flag for rollback until this passes acceptance. |
| I5 | price = catalog price × quantity, in integer cents. | Pricing property tests; fixed-sample checks (m-1029 = USD 150, m-1035 quantity 2, m-1024 injection changes no price). |
| I6 | At most one follow-up question per request. | A database CHECK on the follow-up count, plus a test that tries to force a second question. |
| I7 | No secret is ever committed. | gitleaks in CI and as a pre-commit hook; typed settings that refuse to start without values. |
| I8 | Any request that may need asynchronous clarification has a valid, authorized reply path. | A web-form submission with no customer email is rejected (phone-only refused); an email-originated request keeps reliable conversation correlation (e.g. a signed reply token plus `In-Reply-To`/`References`), and an unauthorized or unmatched reply is not applied. Delivery channel and provider stay implementation decisions (`docs/ARCHITECTURE_DECISIONS.md`). |

Technical non-negotiables (the reversible *implementations* are governed by
`docs/ARCHITECTURE_DECISIONS.md`, not pinned here):

- One codebase and container image, run as two processes (**api** and **worker**); the API
  MUST NOT call the AI model.
- The AI pipeline follows the orchestration contract: structured extraction through the AI
  gateway, then code validates, decides, reserves-then-settles cost, and performs side effects.
- A one-command local run MUST exist and MUST stay working at every slice boundary.

## Development Workflow and Quality Gates

- **Spec-driven, slice by slice.** Work proceeds in vertical slices (see
  `docs/IMPLEMENTATION_SLICES.md`). Each slice runs the full Spec Kit path — specify → clarify
  → plan → checklist → tasks → analyze → implement → converge — and ends with a running system
  and passing tests.
- **The plan follows recorded decisions.** `/speckit-plan` MUST match `docs/ARCHITECTURE_DECISIONS.md`
  (D1–D18 and the LLM-orchestration decision). Where a plan diverges from a recorded decision,
  stop and get a human decision before writing it.
- **Fix at the source.** When analyze or converge finds a conflict, fix the spec, plan, or
  tasks — not only the code — then re-run, so documents and code never drift.
- **Decision log.** Every time the agent is overruled or corrected, record it in
  `docs/decision-log.md`: date, what the agent proposed, what was chosen, and why.
- **CI gates (a failure blocks merge).** Strict TypeScript compile, lint, module-boundary
  rules (dependency-cruiser), unit and real-database tests, interface contract tests, the
  secret scan, `terraform validate`, the image scan, and the recorded 40-sample evaluation.
- **Plain language.** Documentation is written in plain language and defines each term on first use.

## Governance

This constitution supersedes other practices for this project. It is authored from, and stays
consistent with, the source-of-truth documents in `docs/` (the take-home brief, the
Architecture Guide, and the derived planning docs); where this constitution and a planning doc
disagree, this constitution wins and the planning doc is corrected.

- **Amendments** require a written entry in `docs/decision-log.md` stating the change and its
  rationale, and a version bump in the line below.
- **Versioning** follows semantic versioning: **MAJOR** for backward-incompatible governance or
  principle removals/redefinitions; **MINOR** for a new principle or materially expanded section;
  **PATCH** for clarifications and non-semantic refinements.
- **Compliance.** Every spec, plan, task list, and change set MUST be reviewed against these
  principles and invariants before it is accepted. Any added complexity MUST be justified
  against Principle V. An invariant regression is never an acceptable trade-off.

**Version**: 1.2.0 | **Ratified**: 2026-11-03 | **Last Amended**: 2026-11-04
