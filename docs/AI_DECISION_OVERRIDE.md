# AI Decision Override — Human-Directed Architecture Corrections

> **Purpose.** The take-home asks for a genuine example where an AI coding assistant proposed a
> design and the human engineer rejected or changed it. This document presents the single strongest
> example in full, a ~75-second Loom narration, and the supporting code — followed by a ranked audit
> of every override found in the repository's real artifacts.
>
> **Evidence policy.** Nothing here is invented. Every claim cites a real commit, file+line range,
> test, Spec Kit artifact, or a verbatim human instruction recovered from this project's Claude
> conversation history. Where a candidate is a *documented decision* without a captured original AI
> proposal, or is *not implemented*, it is labelled as such. See [Sources & method](#sources--method).

---

## Headline override — Request idempotency: content-fingerprint → explicit client-generated submission identifiers

**Status: PROVEN.** Original AI proposal, human rejection, and shipped implementation are all
independently evidenced (conversation + Spec Kit clarification log + commit + code + tests).

### 1. What the AI proposed

In the Feature 002 (`intake-queue`) `/speckit-clarify` pass, the assistant's first idempotency
strategy made a **normalized content fingerprint the default dedup key** — i.e. two inbound messages
were "the same submission" when their canonicalized text matched. The repository preserves this as a
named, superseded default in the feature spec's own clarification log:

> *"Content-based deduplication (**the earlier content-fingerprint default**) is **rejected**…"*
> — [specs/002-intake-queue/spec.md:173-178](specs/002-intake-queue/spec.md#L173-L178)

### 2. The human correction

The human engineer rejected content-based idempotency outright and specified an explicit,
client-generated identifier instead. Verbatim instruction (Claude conversation history, 2026-11-03):

> *"Revise the Feature 002 idempotency clarification. **Do not use normalized message-content hashing
> as the default idempotency strategy.** … The normalized ingestion API requires a stable source
> submission identifier or idempotency key … If the same identifier is reused with different content,
> return an explicit idempotency conflict (HTTP 409) … **never dedup different ids by content; replies
> are correlated, not deduped.**"*

Encoded back into the spec as a dedicated revision session and functional requirements:

- [specs/002-intake-queue/spec.md:158-161](specs/002-intake-queue/spec.md#L158-L161) — keyed by a
  required stable source submission identifier, **never** by content; email uses the provider
  `Message-ID`, the web form uses a browser-generated UUID.
- [specs/002-intake-queue/spec.md:200-201](specs/002-intake-queue/spec.md#L200-L201) — FR-006: same key
  + different content → **409**, original request unchanged.
- [specs/002-intake-queue/spec.md:234-237](specs/002-intake-queue/spec.md#L234-L237) — a content
  fingerprint is permitted **solely** for same-identifier conflict detection, never to key dedup.
- Captured as decision **D3** in [docs/ARCHITECTURE_DECISIONS.md:71-77](docs/ARCHITECTURE_DECISIONS.md#L71-L77).

### 3. Why the original approach was weaker (the senior-level judgment)

Content equality is **not** logical-submission equality — in both directions, and both failure modes
are silent:

- **False merge (lost work).** Two different customers who both write *"the chain keeps slipping"*, or
  the same customer legitimately asking for the same repair twice, would collapse into **one** request.
  A dropped second job is invisible — no error, just a bike that never gets booked.
- **False distinct (duplicate work orders).** A client retry where the body is reformatted (a quoted
  reply, a re-wrapped line, a trailing signature) hashes differently and creates a **second** work
  order for one real submission — the exact duplicate-order failure the brief calls out as a hard part.

Content hashing also couples idempotency to text normalization forever (every Unicode/whitespace rule
becomes a correctness dependency) and has no clean answer for email threads, where a reply must be
*correlated* to an existing request, not deduped against it. A **client-generated stable operation id**
cuts all of this: the producer declares "this is the same logical action," retries are safe by
construction, and the content hash is demoted to a cheap guard that catches id-reuse mistakes.

### 4. What was actually implemented

- Idempotency keyed **only** on `(shop_id, source, submission_id)`, enforced in the database:
  [src/migrations/3000_intake.cjs:18](src/migrations/3000_intake.cjs#L18),
  [:24](src/migrations/3000_intake.cjs#L24) (`messages_idempotency_uniq`).
- Atomic insert-on-conflict + conflict resolution:
  [src/modules/intake/index.ts:38-39](src/modules/intake/index.ts#L38-L39) (contract comment),
  [:50-58](src/modules/intake/index.ts#L50-L58) (`ON CONFLICT … DO NOTHING`),
  [:76-95](src/modules/intake/index.ts#L76-L95) (same-id → compare fingerprint → replay or 409).
- Fingerprint scoped to conflict detection only, with the intent stated in code:
  [src/modules/intake/canonical.ts:4-16](src/modules/intake/canonical.ts#L4-L16)
  (*"used ONLY for same-identifier conflict detection — never to key or merge deduplication"*).
- Shipped in commit **`4df4cfd`** — `feat(002-intake-queue): durable async intake with idempotency & pg-boss`.

**Tests (real PostgreSQL via Testcontainers), [tests/integration/intake.test.ts](tests/integration/intake.test.ts):**

| Behavior | Test |
|---|---|
| 50 concurrent identical submits → exactly **one** request | [:90](tests/integration/intake.test.ts#L90) |
| same id + different content → **409**; whitespace-only diff → replay | [:105](tests/integration/intake.test.ts#L105) |
| **different ids + identical content → two requests** (content-merge never occurs) | [:114](tests/integration/intake.test.ts#L114) |
| HTTP contract: 202 / 409 / 422 | [:124](tests/integration/intake.test.ts#L124), [:133](tests/integration/intake.test.ts#L133) |

### 5. Tradeoffs & remaining limitations (state these in the interview)

- The guarantee is only as good as the client-supplied id. The web form mitigates this by generating a
  **browser UUID** so refresh/retry is idempotent; email leans on the provider `Message-ID`. A caller
  that sends a fresh id per retry still double-submits — the id is a *contract*, not a server-side
  inference. This is the deliberate tradeoff: correctness moves to an explicit interface instead of a
  fragile heuristic.
- The fingerprint still depends on the canonicalization rules — but only to decide 409-vs-replay for a
  *reused* id, so a rule change can never silently merge or split distinct submissions.
- Cross-channel look-alikes (same customer, same service, two channels) are intentionally **flagged,
  never merged** (D9) — handled by review, not by idempotency.

---

## ~75-second Loom narration

> *(≈ 180 words, ~150 wpm. Screen: split `specs/002-intake-queue/spec.md` lines 173-178 against
> `src/modules/intake/index.ts` lines 50-95, then the passing `intake.test.ts`.)*

"Here's a real override. When I ran Spec Kit's clarify step on the intake feature, the assistant's
first idempotency design made a **normalized hash of the message text** the dedup key — same text meant
same submission. I rejected that. The repo still records it, right here: *'the earlier content-fingerprint
default is rejected.'*

The problem is that content equality isn't logical-submission equality. Two different riders can type
'the chain keeps slipping,' and I'd silently drop one booking. Or a client retries with a reformatted
body, and I'd create a **duplicate work order** — the exact failure the brief warns about.

So I moved idempotency to an **explicit client-generated identifier** — a browser UUID from the web
form, the Message-ID from email — keyed as shop-plus-source-plus-id in a unique constraint. The content
hash stays, but **only** to catch id reuse: same id, different content returns a 409.

You can see it enforced in the insert-on-conflict path, and proven by tests — including *different ids,
identical content, two requests*. Content merging never happens."

---

## Ranked audit of all override candidates

Ranked by strength as an interview example: clarity of the "AI proposed → human changed" arc,
architectural weight, and completeness of evidence (conversation + artifact + code + test).

| # | Override | Status | Strength | Evidence anchor |
|---|---|---|---|---|
| **1** | **Content-fingerprint → explicit submission-identifier idempotency** (above) | **PROVEN** | ★★★★★ | spec:173-178, `index.ts`, `4df4cfd`, intake tests |
| **2** | **Mandatory real-time webhook → polling-by-default for inbound email** | **PROVEN** | ★★★★★ | human prompt "webhooks are NOT required for MVP"; D21.1 |
| **3** | **Custom reserve/settle budget ledger → LiteLLM-native teams/virtual-keys/budgets** | **PROVEN** (with reversal nuance) | ★★★★☆ | human "REDESIGN…USING LITELLM NATIVE" + "I approve"; D7; constitution 1.2.0→2.0.0 |
| **4** | **Local Mailpit/SMTP → Resend as the sole provider** | **PROVEN** | ★★★★☆ | human "REPLACE MAILPIT COMPLETELY WITH RESEND"; D21 |
| **5** | **Hand-rolled auth forbidden → Better Auth library; admin-created staff, no invitations** | **PROVEN** | ★★★☆☆ | human 010 prompt "No invitations", "do not implement custom password/session crypto"; D20 |
| **6** | **Staff browser login kept separate from shop machine API keys** (three credential systems never fall back) | **PROVEN** (constraint) | ★★★☆☆ | human "keep Feature 009 API keys separate"; D19/D20 |
| **7** | **Never auto-cancel from unverified customer text; require verified channel + staff confirm** | **DOCUMENTED — NOT IMPLEMENTED** | ★★☆☆☆ | D9 only; see honesty note below |

### Candidate detail (condensed)

**#2 — Webhook → polling (PROVEN; a "special attention" item).**
After the assistant completed the Resend migration (D21) with a **Svix-signed webhook** as the inbound
mechanism, the assistant's own Resend research surfaced the friction: *"there is NO built-in tunnel …
local dev = public URL (ngrok/Tailscale Funnel)."* The human challenged the mandatory-webhook
assumption directly: *"Webhooks are NOT required for local development or the MVP … Poll every 60
seconds by default … Preserve the existing signed webhook handler as optional … disabled by default."*
**Current reality (verified in code):** polling **is** the default — `RESEND_POLLING_ENABLED` defaults
to `true` ([src/platform/config/index.ts:68](src/platform/config/index.ts#L68)); the webhook mounts
**only** when `RESEND_WEBHOOK_SECRET` is set, and a malformed secret disables the webhook without
crashing the API or affecting polling
([src/api/server.ts:77-87](src/api/server.ts#L77-L87)). A self-rescheduling pg-boss singleton with a
durable lease drives discovery; 9 real-PostgreSQL tests cover it
([tests/integration/email-poll.test.ts:63-141](tests/integration/email-poll.test.ts#L63-L141)).
Decision **D21.1** ([docs/ARCHITECTURE_DECISIONS.md:416-438](docs/ARCHITECTURE_DECISIONS.md#L416-L438)).
*Tradeoff:* up-to-60s added latency and polling cost vs. no public URL/tunnel/webhook-dashboard for a
reviewer; webhooks remain the recommended production path.

**#3 — Custom ledger → LiteLLM-native budgets (PROVEN, honest reversal).**
The human directed *"REDESIGN LLM BUDGET ENFORCEMENT USING LITELLM NATIVE CAPABILITIES … make LiteLLM
the sole budget admission and accounting authority after successful verification"* and set the
guardrail *"If LiteLLM native enforcement cannot be validated safely, retain the existing tested budget
path."* Zero-cost testing (mock upstream + configured pricing, **no paid calls**) then found native
enforcement is **eventually-consistent** — a bounded **soft cap** that can overshoot by ~one in-flight
call — so invariant **I4** was honestly amended from "never exceeds" (hard) to "bounded overshoot"
(soft), via a tracked **constitution 1.2.0 → 2.0.0** governance trail. This is the most senior-maturity
story (measure, then correct the *guarantee*, not just the mechanism) but is a weaker *clean* override
than #1 because the human drove the redesign rather than rejecting a concrete AI proposal. See
[docs/decision-log.md:28-64](docs/decision-log.md#L28-L64) and D7
([docs/ARCHITECTURE_DECISIONS.md:109-138](docs/ARCHITECTURE_DECISIONS.md#L109-L138)). Legacy path kept
behind `BUDGET_AUTHORITY=legacy` for rollback.

**#4 — Mailpit → Resend (PROVEN).** Human: *"REPLACE MAILPIT COMPLETELY WITH RESEND … Resend as the
ONLY email provider … Do not retain a silent Mailpit fallback."* Note this reversed an **earlier
human-authorized** Mailpit choice (the autonomous mandate said "Use Mailpit"), so it is a human→human
course-correction executed by the AI more than a rejection of an AI proposal — strong evidence,
slightly off-target for "the AI proposed it." Decision **D21**
([docs/ARCHITECTURE_DECISIONS.md:383-414](docs/ARCHITECTURE_DECISIONS.md#L383-L414)).

**#5/#6 — Auth library + credential separation (PROVEN as constraints).** In Feature 009 the human
pre-empted a human-identity platform entirely (*"Do NOT implement full human identity management … staff
invitations … a new RBAC user platform"*), then in Feature 010 directed **Better Auth** with
**admin-created staff accounts, "No invitations,"** the **native pg adapter** (*"Do not introduce Prisma
or Drizzle"*), and explicitly forbade hand-rolled crypto (*"Do not implement custom password
verification or custom session-token cryptography"*). The human also mandated that Better Auth sessions,
Feature 009 shop API keys, and LiteLLM virtual keys stay **three separate systems that never fall back
to each other**. These are human-imposed *constraints that forbade* the AI from hand-rolling, rather
than reversals of a concrete AI proposal. Decisions **D19/D20**
([docs/ARCHITECTURE_DECISIONS.md:341-381](docs/ARCHITECTURE_DECISIONS.md#L341-L381)).

### Honesty note — cancellation authorization (a "special attention" item)

The take-home flags *"whether cancellation authorization truly requires identity confirmation."* The
honest finding: the **"never cancel on a name match; require a verified channel or signed link, else a
staff-confirmed proposal"** rule is a **documented design decision (D9,
[docs/ARCHITECTURE_DECISIONS.md:157-165](docs/ARCHITECTURE_DECISIONS.md#L157-L165))** — it is **not
implemented**. A repo-wide search finds exactly one reference to cancellation in `src/`: the string
`'cancelled'` as a state enum value in [src/api/openapi.ts:53](src/api/openapi.ts#L53). There is no
cancellation service, no verified-channel check, and no auto-cancel path. So the correct interview
statement is: *"We rejected auto-cancelling from unverified text as a **principle**, and deliberately
**left cancellation unbuilt** rather than ship an unsafe version"* — not *"identity confirmation is
enforced in code."* Presenting D9 as a shipped safeguard would overstate the implementation. (The
assistant's deferral is recorded in
[docs/AUTONOMOUS_HANDOFF.md:144](docs/AUTONOMOUS_HANDOFF.md#L144).)

> **Not found:** no "Fastify → Express" override exists in this project's conversation history. The
> `"your idea wins"` note in D12 ([docs/ARCHITECTURE_DECISIONS.md:202](docs/ARCHITECTURE_DECISIONS.md#L202))
> refers to the upstream architecture *guide* author, not an AI proposal made and rejected inside this
> repo's build — so it is **not** claimed here as a PROVEN override.

---

## Sources & method

Audited on 2026-11-04 against:

- **Git history** — `git log` across branches 001–004 + `main` (e.g. `4df4cfd`, `fe0cc15`, `c1071a1`,
  `601d240`, `3ba947d`, `3174f6a`).
- **Spec Kit artifacts** — `specs/00{1..10}-*/` (spec/plan/research/data-model/contracts/tasks +
  clarification session logs).
- **Decision records** — [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md) (D1–D21.1),
  [docs/decision-log.md](docs/decision-log.md), [docs/AUTONOMOUS_DECISIONS.md](docs/AUTONOMOUS_DECISIONS.md),
  [docs/AUTONOMOUS_HANDOFF.md](docs/AUTONOMOUS_HANDOFF.md), `.specify/memory/constitution.md`.
- **Source + tests** — `src/` and `tests/integration/` (real PostgreSQL via Testcontainers).
- **Claude conversation history** — the project's local session transcript
  (`~/.claude/projects/.../8b6ae836-….jsonl`, ~11k events). Human instructions quoted above are verbatim
  from the human-authored turns in that transcript; they are not reconstructions.

Verbatim human directives are quoted; AI proposals are cited to the artifact that preserves them
(a spec clarification log, a superseded decision, or the transcript). No conversation, commit, test, or
outcome in this document is fabricated.
