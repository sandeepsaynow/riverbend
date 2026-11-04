# Feature 005 — Public web intake form (lean spec)

**Input**: D11. A hosted, per-shop browser form that turns a customer's typed request into the SAME
002 intake path, with mandatory email (I8 reply path), refresh-safe idempotency, and public-endpoint
defences. No new pipeline behaviour — it feeds `source='web'` into `IntakeService.submit`.

## User stories
- **US1 (P1) Submit a repair request.** A customer opens `/f/:slug`, enters email + description, submits,
  and sees a confirmation with a tracking link. Refreshing/retrying does not create a second request.
- **US2 (P1) Public-endpoint safety.** The endpoint resists abuse: origin allowlist + CORS, per-IP/shop
  rate limits, a honeypot, strict size/shape validation, a bot check (Turnstile) behind an interface,
  and a strict CSP on the page.
- **US3 (P2) Track status.** A signed status link shows the request's current state without exposing
  other shops' data or any customer content.

## Functional requirements
- **FR-001**: The shop MUST be derived server-side from a **signed form token** (HMAC over the shop id,
  `WEB_FORM_SIGNING_KEY`), minted when `/f/:slug` is rendered — never trusted from the POST body/URL
  (Constitution III). An invalid/forged token → 401.
- **FR-002**: Email is **mandatory** and format-checked; missing/invalid → 422 (I8). It is stored on the
  message (`customer_email`) as the reply path; it is NOT logged (VII).
- **FR-003**: The browser generates a UUID `submission_id`, persisted in `localStorage`, so refresh/retry
  replays the same `(shop, 'web', submission_id)` → one request (reuses 002 idempotency; 409 on reuse
  with different content).
- **FR-004**: Defences — origin/referer allowlist (`WEB_ALLOWED_ORIGINS`) + CORS; a stricter per-IP rate
  limit on submit; a honeypot field (`website`) that, if filled, is rejected as success-looking (204);
  content ≤ 20,000 chars (reuses `MAX_CONTENT_CHARS`); description required.
- **FR-005**: A bot check (Cloudflare Turnstile) MUST be verified **server-side** behind a
  `TurnstileVerifier` interface. A deterministic fake passes in tests/local (no key); the real verifier
  is used when `TURNSTILE_SECRET` is set. Failure → 403.
- **FR-006**: The page sends a strict `Content-Security-Policy` (no inline-script execution beyond a
  nonce; `default-src 'self'`), and the submit response carries no customer content in logs.
- **FR-007**: The whole web surface is **off unless `WEB_FORM_SIGNING_KEY` is set** (fail-closed; keeps
  the keyless default `make up` and the 69 offline tests unchanged). When off, `/f/*` → 503.

## Invariants touched
- I1 isolation (shop from signed token only), I8 reply path (mandatory email). No change to I2–I6.

## Acceptance (zero external deps)
- Double-submit same UUID → one request; missing email → 422; honeypot filled → rejected (no request);
  forged token → 401; oversize → 422; Turnstile fail → 403; happy path → confirmation + working status
  link; the form page is served with a CSP header.
