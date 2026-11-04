# Riverbend Cycles — Implementation Slices

From the Architecture Guide, Part 8 and Appendix B (Tables 76, 81). The build is cut into
**eight vertical slices**. Each slice ends with **a system that runs and tests that pass**, so
work can stop at any boundary with a smaller finished system rather than a larger half-built one.

One **Spec Kit feature per slice**. The full Spec Kit path runs for every slice (production code):
`/speckit-specify → /speckit-clarify → /speckit-plan → /speckit-checklist → /speckit-tasks →
/speckit-analyze → /speckit-implement → /speckit-converge`, repeating implement/converge until it
reports **Converged**. `/speckit-constitution` runs **once** for the whole project, before slice 001.

> Note: the guide's prompts use `--integration copilot` command names; this project uses the
> **Claude** integration, so the skills are `/speckit-*` (same names). See `ARCHITECTURE_DECISIONS.md`
> Part "Contradictions" item 3.

---

## The eight slices

| Slice | What works when it is done | Decisions | Layer | Rough hrs |
|-------|----------------------------|-----------|-------|-----------|
| **001-foundation** | One-command start/stop. Shops and API keys. **Isolation proven by attack tests.** Health checks (alive/ready), the settings check (refuses to start if a setting is missing), and the 12-service catalog as versioned reference data. | D1, D2, D12, D14 | 1 & 2 | 3 |
| **002-intake-queue** | A message sent to the API is saved **once**, with its job, and answered **202**. Duplicates return the same request (409 on same-id/different-body). A worker takes jobs; a **sweeper** rescues stuck ones. | D3, D4 | 1 | 4 |
| **003-ai-pipeline** | The AI reads a message into a **strict form**. Code validates it, decides, asks **at most one** follow-up, and resumes on the reply. Every call is **recorded**, its cost **reserved then settled**. | D5, D6, D7 | 1 | 6 |
| **004-orders-staff** | **One work order per bike**, priced by code. The open-orders read with totals. Cancel. The **staff screen**. | D8, D9, D17 | 1 & 2 | 4 |
| **005-web-form** | The real hosted form, the status page, the server-side **bot check**, and the rate limits. | D11, D14 | 2 | 5 |
| **006-email** | The **outbox**, email sending via **Resend** (D21; Mailpit retired), the **Svix-signed inbound webhook** + Receiving-API content fetch, and reply matching. | D10 → D21 | 2 | 4 |
| **007-resilience** | Retries, circuit **breaker**, per-shop **bulkhead**, the "AI paused" switch, the **outage and cap demos**, tracing and alerts. | D13, D15, D16 | 1 | 4 |
| **008-eval-and-deploy** | The **40-sample run** + results table, recorded replay, **Terraform + CI**, the README and the architecture note. | D18, Part 7 | 1 | 3 |

Plus, outside the slice count: Terraform/CI/docs is tracked at ~5h in the hours table. **Guide's
total estimate: ~25–38 hours** — several times the brief's ~8-hour budget (see the scope
contradiction in `REQUIREMENTS.md` Part D and `ARCHITECTURE_DECISIONS.md`).

---

## What each slice delivers, in detail

### 001-foundation (D1, D2, D12, D14)
The base every later slice stands on; **calls no AI**.
- One command starts the whole system on a laptop; one command stops it.
- Create a shop + an API key; the key is shown once, stored only as a fingerprint, revocable.
- Every record belongs to exactly one shop; shop A's key can never read/change/delete shop B's
  records, even by guessing ids.
- Health checks: "alive" (process runs) and "ready" (can reach the data store).
- All settings from the environment; refuse to start (clear message) if one is missing; **no secret
  in the repo**.
- The 12 catalog services as versioned reference data, prices in whole cents, shared by all shops.
- **Tests:** a direct-to-datastore attack test as the app role (shop A can't see shop B even if app
  code forgets its filter); a build check that fails when a `tenant_id` table has no policy; a
  refuses-to-start-without-a-setting test.

### 002-intake-queue (D3, D4)
- Intake saves message + request + job in one transaction, returns 202 with a status link.
- Idempotency: unique (shop, source, external id); same body replays, different body → 409.
- Worker leases a job, processes, marks done; a sweeper re-queues work stuck in `processing`,
  settles stale holds, and trips the AI-unavailable deadline.
- **Tests:** 50 parallel posts of m-1003 → one request; a redelivered job is not double-processed.

### 003-ai-pipeline (D5, D6, D7)
- `LlmGateway` interface in front of LiteLLM; a fake OpenAI-compatible server for tests.
- Model fills a strict form; code validates (I3), decides the question (I6), resolves dates, handles
  wrong-shop / price-inquiry / delegation paths.
- Reserve-then-settle ledger (I4): atomic reserve, receipt in `llm_calls` keyed by (request, step,
  attempt), settle real cost; reaper for abandoned holds.
- **Tests:** at-most-one-question (DB CHECK + a test that tries to force a second); invalid output
  never saved; 20 parallel reservations vs a cap of 5 → exactly 5.

### 004-orders-staff (D8, D9, D17)
- One work order per bike, all-or-nothing, unique (shop, request, bike no.); prices copied at
  creation; money in whole cents (I5, I2).
- Open-orders read endpoint with per-order and shop totals.
- Cancel: verified channel auto-cancels, else a staff-confirmed SQL proposal; cancel flag + locked
  final commit for the race.
- Server-rendered staff screen: Needs attention, Open work orders, AI usage, Request detail.
- **Tests:** m-1029 = USD 150; m-1040 = two orders / USD 130; a catalog change leaves old orders
  unchanged; cancel-during-processing leaves no order.

### 005-web-form (D11, D14)
- Hosted hardened form per shop using the common intake path; status page + magic link.
- Email required; Turnstile verified server-side; per-IP/per-shop rate limits; honeypot; origin
  allowlist + CORS; size limits + strict validation; browser idempotency key; output encoding + CSP.
- **Tests:** double-click → one request; honeypot/oversize/bad-origin rejected; stored-XSS payload
  can't execute on the staff screen.

### 006-email (D10)
- `EmailTransport` + inbound adapter via **Resend** (D21); domain-free local testing via a `<id>.resend.app`
  receiving address + the `resend webhooks listen` CLI exercising the
  real inbound path.
- Outbox with retries; signed expiring `reply+<token>@` address + `In-Reply-To`/`References` matching;
  quoted-text stripping; auto-reply/bounce/attachment handling; `Message-ID` de-dup.
- **Tests:** m-1027 reply resumes by email; a failed send → Needs attention, order not rolled back.

### 007-resilience (D13, D15, D16)
- Timeouts, bounded retries (backoff + jitter, one retrying layer), per-process circuit breaker,
  per-shop bulkhead, global "AI paused" switch.
- OpenTelemetry traces (Phoenix local), pino logs (no message text), the eight alerts.
- Privacy: retention job; PII redaction in traces.
- The **outage demo** (fake AI returns 503 → retry/park/drain) and the **cap demo** (tiny cap → held
  requests).
- **Tests:** timeouts/503 retry then park; crash after the AI call → no second charge.

### 008-eval-and-deploy (D18, Part 7)
- Evaluation runner replays all 40 deliveries through the real HTTP API, answers follow-ups like a
  customer, writes `docs/results.md` (outcome, services, total, AI cost, latency per message) and
  scores against the golden set. Three demo runs: cap, outage, m-1038 cancel.
- `make eval` replays recorded answers (free, deterministic, runs in CI); `make eval-live` calls the
  real model (costs money, ledger-tracked — one run is a few dollars; ten runs would break USD 20).
- Terraform (Cloud Run API + worker pool, Cloud SQL, Vertex AI, Secret Manager, Artifact Registry,
  LB + Cloud Armor) via GitHub Actions + Workload Identity Federation; CI runs `terraform validate`
  + `plan` — **no live deploy**.
- The README (honest hours, not-built list, "what breaks first at 100 shops") and the 2-page
  architecture note (`docs/architecture-note.md`, draft in guide Appendix A).

---

## The loop for every slice (the quality gates)

1. `/speckit-specify` — what & why, **no technology**; a shop owner could read and agree.
2. `/speckit-clarify` — targeted questions fold answers into the spec (the 8 open points for 001);
   leave no open question.
3. `/speckit-plan` — technology enters here; **check it matches D1–D18**, not a fresh opinion.
4. `/speckit-checklist` — "unit tests for the requirements": complete, clear, testable.
5. `/speckit-tasks` — every requirement has a task; every invariant has a test task.
6. `/speckit-analyze` — read-only; find conflicts between spec/plan/tasks. **Fix at the source**, re-run.
7. `/speckit-implement` — one phase at a time; it reads the checklist state as a gate.
8. `/speckit-converge` — check code vs spec/plan/tasks; add tasks for gaps; re-run implement +
   converge until **Converged**.

**Working agreements (from the constitution prompt):**
- Every slice ends with a running system and passing tests.
- Every time the agent is overruled or corrected, log it in **`docs/decision-log.md`** (date, what
  it proposed, what we chose, why) — the best entry is the Loom answer.
- When `analyze`/`converge` finds a problem, fix the **spec/plan/tasks**, not only the code, then
  re-run — otherwise the documents and code drift apart, which is exactly what these tools prevent.

---

## The cut order, if time runs short (guide Part 8)

1. The Phoenix tracing profile.
2. Recorded-answer replay (then run live evals sparingly on the cheaper model, watch the ledger).
3. The possible-duplicate flag.
4. Staff-screen polish (the API stays).
5. The bot-check widget (the server-side checks stay).

**Never cut:** shop isolation, idempotency, schema validation, the spend cap, failure handling,
tests, the results table, the not-built list, and an honest README.

**To stay near 8 hours:** build Layer 1 only, keep Layer 2 as *designed* in the architecture note,
and say so in the not-built list — a complete, honest answer to the brief.

> **D23 (2026-11-04):** Feature 003 extraction adds a `cancellation` kind → needs_review (`cancellation_requires_verification`); no auto-cancel, no order, no clarification. See ARCHITECTURE_DECISIONS D23.
