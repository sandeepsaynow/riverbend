# Riverbend Cycles — Requirements

Derived from the two source documents, kept unchanged:

- `docs/Take-home brief_ Senior Engineer (Product Architect).pdf` (the assignment)
- `docs/Riverbend_Architecture_Guide.docx` (our design)

This file separates **what the assignment mandates** from **what our design adds on top**.
Nothing here chooses technology — that lives in `ARCHITECTURE_DECISIONS.md`.

---

## Part A — Mandatory assignment requirements (Layer 1, never cut)

The brief: build a small service that turns messy inbound messages into structured
work orders for a fictional chain of 3 bicycle repair shops. Each shop is a separate
tenant; staff at one shop must never see another shop's customers or orders.

### A1. Functional requirements (what the service does)

| # | Requirement | Source |
|---|-------------|--------|
| F1 | Accept inbound messages through an HTTP endpoint, each tagged with the shop it belongs to. | Brief "What the service does" 1 |
| F2 | Use an LLM agent to extract a work order: bike type, reported issues, a mapped list of services from the fixed 12-service catalog, urgency, and a requested date. | Brief 2 |
| F3 | Ask the customer **one** follow-up question when a required field is missing or ambiguous, and resume when they reply. | Brief 3 |
| F4 | Validate every model output against a schema. Output that fails validation is **never** saved as a work order. | Brief 4 |
| F5 | Expose a read endpoint that lists a shop's **open** work orders, with an estimated total. | Brief 5 |

### A2. The hard parts (on purpose)

| # | Requirement | Source |
|---|-------------|--------|
| H1 | Processing is asynchronous. The same message can arrive twice; it must produce **one** work order (idempotency). | Brief "hard parts" 1 |
| H2 | The LLM provider will be slow or down some of the time. Show what the **customer** and the **shop** see when it is. | Brief 2 |
| H3 | Each shop has a **monthly LLM spend cap**. Show how it is enforced and what happens at the cap. | Brief 3 |
| H4 | The price estimate must come from the catalog, **computed in code**. The model may pick services; it must **not** do arithmetic or invent prices. | Brief 4 |

### A3. Tenancy & data

| # | Requirement | Source |
|---|-------------|--------|
| T1 | Each of the 3 shops (`rb-downtown`, `rb-northside`, `rb-lakeshore`) is a separate tenant. | Brief scenario |
| T2 | Staff at one shop must **never** see another shop's customers or orders. | Brief scenario |
| T3 | The 3 shops share **one** catalog of 12 services (prices in USD). `requires_inspection: true` still includes the listed price in the estimate. | Brief "Catalog" |

### A4. Inputs provided by the brief

- A **catalog** as JSON: 3 shops, USD currency, 12 services with `code`, `name`, `price`, `minutes`, `requires_inspection`.
- **40 sample messages** for 1 day (Tuesday 22 September 2026, shop local time), each with `message_id`, `shop_id`, `channel` (email/web), `received` time, and free-text body. 8 are deliberately tricky; the brief does not say which.

### A5. Deliverables (what we send back)

| # | Deliverable | Source |
|---|-------------|--------|
| D-1 | A Git repository with code, tests, and a **one-command local run**. | Brief "What you send us" 1 |
| D-2 | An **architecture note, 2 pages max**: a diagram, module boundaries, the data model, how tenancy is isolated, and the **three decisions most worth challenging**. | Brief 2 |
| D-3 | A **GCP deployment path**. Live deploy is optional; infrastructure-as-code + a written plan scores the same. Name the services and why. | Brief 3 |
| D-4 | A **results table** from running the 40 samples: work orders created, follow-ups asked, failures, total model spend. | Brief 4 |
| D-5 | A **"not built" list**: what was cut, what we'd build next, what breaks first at 100 shops. | Brief 5 |
| D-6 | A **Loom video, 5–10 min**: "one AI decision I overrode" — the proposal, what was wrong, what we did instead. | Brief 6 |
| D-7 | Availability for a **60-minute follow-up call**. | Brief |

### A6. Constraints & rules

| # | Constraint | Source |
|---|------------|--------|
| C1 | **Time:** about 8 hours, within 5 calendar days. Report honestly how long was spent. Finishing everything is not the goal. | Brief "Rules" |
| C2 | **Stack:** free choice of language/framework and LLM provider. | Brief |
| C3 | **Model spend:** keep under **USD 20**. | Brief |
| C4 | **Tests:** cover the parts considered risky, and say why. | Brief |
| C5 | **Secrets:** never commit an API key; show how the service reads configuration. | Brief |
| C6 | Clarifying questions by email are allowed and encouraged. | Brief |

### A7. Evaluation criteria (how we are scored, 1–4 per area)

| Area | Weight | A "4" looks like |
|------|--------|------------------|
| Architecture & boundaries | 30% | Clear modules, a data model enforcing tenant isolation, decisions defended in the note. |
| Failure handling | 20% | Duplicate messages, provider outages, and the spend cap each handled **and demonstrated**. |
| AI judgement (Loom) | 20% | A real override with a specific reason, not a cosmetic tweak. |
| Correctness of AI output | 15% | Schema-validated output, prices computed in code, tricky samples handled. |
| Scope honesty & communication | 15% | A candid not-built list and results table; the follow-up call matches the note. |

> Half the weight sits on **structure and failure handling**, not on clever AI.

---

## Part B — Additional product features (our design's extensions)

The Architecture Guide (Part 8) organizes work into three layers. Layer 1 above is the
brief. The items below are **beyond** the brief — deliberate product additions. They raise
quality but also raise scope well past the 8-hour budget (see the contradiction note).

### B1. Layer 2 — built for real in our design

| # | Feature | Rationale (guide) |
|---|---------|-------------------|
| P1 | **Real hosted web form** per shop (not a demo): mandatory email, bot check (Turnstile), rate limits, honeypot, CSP, idempotency key, status page + magic link. | D11 |
| P2 | **Real email adapters**: outbound + inbound via **Resend** (sole provider, D21; Mailpit/SMTP retired). Inbound by **Receiving-API polling** (default local/MVP, D21.1 — no webhook/URL/tunnel) or the optional **Svix-signed webhook** (`/webhooks/resend`); both fetch content, reply-match, de-dup, and auto-resume. | D10 → D21 → D21.1 |
| P3 | **Staff screen** (server-rendered): "needs attention", open work orders with totals, AI usage, request detail with retry/resume/approve/confirm-cancel actions. | D17 |
| P4 | **One work order per bike** (not per request), created all-or-nothing in one transaction. | D8 |
| P5 | **Forced row-level security** tenant isolation, proven by direct-to-DB attack tests. | D2 |
| P6 | **Reserve-then-settle spend ledger** in Postgres as the authority, with LiteLLM budgets as a second fence. | D7 |
| P7 | **Transactional outbox** so a crash never loses an order or an email. | D10 |
| P8 | **Request state machine** with versioned transitions. | D5 |
| P9 | **Evaluation harness** that replays all 40 samples and scores against a hand-labelled golden set. | Part 7 |

### B2. Core+ — built if time allows

- Possible-duplicate flag (cross-channel look-alikes, flag only, never merge) — D9.
- Phoenix tracing profile (local OTel backend) — D13.
- Recorded-answer replay ("cassettes") for free, deterministic eval — Part 7 / D6.

### B3. Layer 3 — designed, **not** built

Live email on a real domain (DNS/MX/SPF/DKIM); automatic merging of similar requests;
appointment scheduling; SMS; staff single sign-on and roles; a local-model fallback when
the cap is reached; per-shop analytics dashboards; manual order creation; the data-erasure
endpoint. (Architecture Guide Part 8, Layer 3.)

### B4. Cross-cutting additions the guide introduces (not in the brief)

- **Privacy & retention** (D15): never log message text; configurable retention (~90 days) then reduce to metrics; DPA checks; consent line on the form. *The brief and the original notes did not cover privacy.*
- **Security beyond tenancy** (D14): hashed revocable API keys, signed single-purpose customer tokens, prompt-injection containment, secret scanning, supply-chain hardening, OWASP API Top 10 mapping.
- **AI kill switch**, data-retention rule, and DPA check (guide "Where I changed your design").

---

## Part C — Open assumptions the brief leaves unspecified

The brief is silent on these; the guide states a default for each (to be confirmed with the
"shop owner" / reviewer, not silently assumed). Carried into `/speckit-clarify`.

| # | Question | Guide's proposed default |
|---|----------|--------------------------|
| Q-TZ | Time zone of "shop local time" | Each shop has a named zone (e.g. `America/Chicago`); one named zone assumed for the 40 samples, documented in README. |
| Q-REQ | What counts as "required" (for the one follow-up) | ≥1 catalog service, and for per-wheel services, which wheels. Bike type and date never block. |
| Q-OPEN | What "open" work orders means | Status `open` or `in progress`. |
| Q-CANCEL | Cancelling | Never on a name match alone; verified channel auto-cancels, else staff confirm. **Open point:** may a customer cancel work already in progress? |
| Q-MONTH | Which month the cap uses | Shop's local calendar month, reset local midnight on the 1st; a call charged to the month it happens in. |
| Q-CAP | Behaviour at the cap | Honest template notice to customer (no AI); staff see held requests + "AI paused"; operator may raise the cap with an audit note. |
| Q-FORM | Web form fields | Email required; name/phone optional; message ≤ ~2,000 chars; one consent line; no attachments in v1. |
| Q-RETAIN | Retention | Full prompts/answers 90 days, then metrics + fingerprints only. |

See `EDGE_CASES.md` for the sample-by-sample expectations and `IMPLEMENTATION_SLICES.md`
for build order.

---

## Part D — Contradictions & divergences (NOT silently resolved)

These require a human decision; see the dedicated section at the end of
`ARCHITECTURE_DECISIONS.md` for the full list. Summary:

1. **Effort vs scope.** Brief C1 says ~8 hours; the guide's plan is ~25–38 hours (Layer 1+2). The guide acknowledges this openly and offers a "Layer 1 only" path to stay near 8 hours.
2. **"Synthetic / throwaway" framing.** Brief: "We will not use your work… nothing goes into our codebase." Guide Promise 3 **withdraws** the synthetic-data framing and designs for real customers/data/money. Deliberate, but a philosophical divergence from the brief's framing.
3. **Spec Kit integration.** Guide Appendix B instructs `--integration copilot`; this project was initialized with `--integration claude` per the engagement. Already decided (Claude), flagged here so it is not silent.
4. **Dataset shape.** Brief says "40 sample messages, 8 deliberately tricky"; the guide observes only **39 distinct IDs** (m-1003 delivered twice at rows 3 and 14; no m-1014) and treats **more than 8** messages as tricky. A dataset ambiguity to confirm.

| P2 | **Portal CSRF canonical-origin policy** (D20.2): state-changing POSTs validate the full scheme://host:port Origin against an exact allowlist (prod = one HTTPS origin; dev adds the loopback sibling). | D20.2 |

| P1 | **Portal double-submit CSRF** (D20.3): cookie-authed state-changing POSTs require an HttpOnly SameSite=Lax rb_csrf cookie matching a hidden _csrf field (origin-independent), plus the exact-origin allowlist; Referrer-Policy strict-origin-when-cross-origin. | D20.3 |
