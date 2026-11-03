# Feature Specification: Foundation — Shops, Credentials & Isolation

**Feature Branch**: `001-foundation`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "Slice 001-foundation — the base every later slice stands on. One-command start/stop; create shops and their API credentials; database-enforced shop isolation proven by attack tests; liveness/readiness checks; refuse-to-start when a required setting is missing; the 12-service catalog as versioned reference data. Calls no AI."

## User Scenarios & Testing *(mandatory)*

This feature is the operational and safety foundation for a multi-tenant service used by a
chain of independent bike shops. It does not yet accept customer messages or do any AI work;
its job is to make the system runnable, provisionable, and — above all — safe to share between
shops. Everything here is read by, and should be agreeable to, a shop owner who cares that no
other shop can ever see their customers or orders.

### User Story 1 - A shop's data is never visible to another shop (Priority: P1)

An operator provisions two separate shops. Each shop's staff and systems authenticate with a
credential that belongs to exactly one shop. No matter what a request tries — reading, changing,
or deleting records, even by guessing another shop's record identifiers — a credential can only
ever reach its own shop's data.

**Why this priority**: This is the single most serious guarantee of the whole service. A leak
between shops cannot be undone, and half the evaluation weight sits on tenancy and structure. If
only this story shipped, the service would still have demonstrated the one thing it must never
get wrong.

**Independent Test**: Provision shop A and shop B, give each a credential, and attempt every
cross-shop access (read, update, delete) using shop A's credential against shop B's records,
including by supplying shop B's exact record identifiers. Every attempt is denied or returns
nothing, and the same holds when the data store is accessed directly as the running
application's own role (not only through the application).

**Acceptance Scenarios**:

1. **Given** two provisioned shops each with records, **When** shop A's credential requests a
   record that belongs to shop B (by its identifier), **Then** the request is denied and no part
   of shop B's data is returned.
2. **Given** two provisioned shops, **When** shop A's credential attempts to modify or delete a
   shop B record, **Then** the attempt fails and shop B's data is unchanged.
3. **Given** application logic that forgets to filter by shop, **When** a query runs as the
   application's own data-store role, **Then** isolation still holds and no other shop's rows are
   returned.
4. **Given** a request with no credential, an unknown credential, or a revoked credential, **When**
   it reaches any shop-scoped operation, **Then** it is rejected before any data is read.

---

### User Story 2 - Provision a shop and issue a revocable credential (Priority: P1)

An operator can create a new shop and issue an API credential that acts on that shop's behalf.
The credential is shown exactly once at creation. Afterwards the system keeps only a fingerprint
of it, never the credential itself, and the operator can revoke it at any time.

**Why this priority**: Nothing else — including the isolation guarantee above — can exist or be
tested without the ability to create shops and authenticate as one. It is a prerequisite for the
entire service, so it shares top priority.

**Independent Test**: Create a shop, receive its credential once, successfully authenticate a
request with it, confirm the raw credential cannot be retrieved again, then revoke it and confirm
the next authenticated request fails.

**Acceptance Scenarios**:

1. **Given** an operator, **When** they create a shop, **Then** a shop identity exists that can
   own records.
2. **Given** a shop, **When** the operator issues a credential, **Then** the full credential is
   shown exactly once and cannot be retrieved again afterward.
3. **Given** an issued credential, **When** a request presents it, **Then** the request is
   authenticated as acting for that one shop, with the shop identity taken from the credential and
   never from the request body or path.
4. **Given** an active credential, **When** the operator revokes it, **Then** every later request
   using it is rejected, while the shop's other active credentials continue to work.
5. **Given** a shop with more than one active credential, **When** a credential authenticates a
   request, **Then** that credential's last-used timestamp is updated.

---

### User Story 3 - Run the whole system with one command, with health signals (Priority: P2)

An operator can start the entire system on a local machine with a single command and stop it with
a single command. Once running, the system reports whether it is alive (the process is up) and
whether it is ready (data store reachable, migrations applied/compatible, configuration valid, and
shop-isolation policies enforced — see FR-013).

**Why this priority**: A reliable one-command local run is an explicit deliverable and the basis
for every demo and test. Health and readiness signals are what an operator and later automation
use to know the system is actually serving.

**Independent Test**: From a clean checkout, run the start command and confirm the system reaches
a ready state; query liveness and readiness and confirm they report correctly; take the data store
away and confirm readiness turns not-ready while liveness stays alive; run the stop command and
confirm a clean shutdown.

**Acceptance Scenarios**:

1. **Given** a clean local environment, **When** the operator runs the single start command, **Then**
   the system comes up and reports ready.
2. **Given** a running system, **When** liveness is queried, **Then** it reports alive while the
   process is running.
3. **Given** a running system whose data store is unreachable, **When** readiness is queried, **Then**
   it reports not-ready even though liveness still reports alive.
4. **Given** a running system, **When** the operator runs the single stop command, **Then** the
   system shuts down cleanly.

---

### User Story 4 - Fail fast on misconfiguration; never commit a secret (Priority: P2)

All configuration comes from the environment. If a required setting is missing, the system refuses
to start and says clearly which setting is absent, rather than starting in a half-configured state.
No secret value is ever stored in a committed file.

**Why this priority**: Silent misconfiguration and leaked secrets are classic, costly failures.
Refusing to start is safer than running wrong, and "never commit a secret" is a non-negotiable
rule of the service.

**Independent Test**: Remove a required setting and confirm the system refuses to start with a
message naming that setting; run an automated secret scan over the repository and confirm it finds
nothing.

**Acceptance Scenarios**:

1. **Given** a required setting is missing or empty, **When** the system is started, **Then** it
   refuses to start and names the missing setting.
2. **Given** all required settings are present, **When** the system is started, **Then** it starts
   normally.
3. **Given** the repository, **When** an automated secret scan runs, **Then** it reports zero
   secrets committed.

---

### User Story 5 - A shared, versioned service catalog (Priority: P3)

All shops share one catalog of exactly twelve repair services. Each service has a code, a name, a
price, an estimated duration, and a flag for whether it requires an inspection. Prices are held as
whole cents, and the catalog is versioned so that changing a price later never changes the meaning
of prices already recorded against past work.

**Why this priority**: The catalog is reference data every later slice depends on for pricing, but
it carries no behaviour of its own in this slice, so it ranks below the runnability and safety
stories.

**Independent Test**: Read the catalog as each of two shops and confirm both see the same twelve
services with identical codes and prices in whole cents; confirm the catalog reports a version.

**Acceptance Scenarios**:

1. **Given** any provisioned shop, **When** its catalog is read, **Then** exactly twelve services
   are returned, each with a code, name, whole-cent price, estimated duration, and inspection flag.
2. **Given** two shops, **When** each reads the catalog, **Then** both see the identical shared set
   of services.
3. **Given** the catalog, **When** it is read, **Then** it carries a version that identifies the set
   of prices in effect.

---

### Edge Cases

- A request presents a valid credential but references a record identifier that belongs to another
  shop → treated as not found; no existence or content of the other shop's record is revealed.
- A request arrives with no credential, a malformed credential, or a previously revoked credential →
  rejected before any shop data is accessed.
- A request attempts to set or override its shop identity through the request body or path → ignored;
  the shop identity always comes from the credential.
- A new shop-owned category of data is added without an isolation rule → an automated check fails
  before release, rather than the gap reaching production.
- A required setting is present but empty, or malformed → treated as missing; the system refuses to
  start.
- The data store is reachable at start but becomes unreachable later → readiness reports not-ready;
  liveness continues to report alive.
- The data store is reachable but the expected schema/migrations are not fully applied → readiness
  reports not-ready while liveness continues to report alive.
- Required migrations are missing, the schema is incompatible, or a required shop-isolation policy is
  absent at startup → the system fails startup and serves no protected request (readiness not-ready).
- The required administrative bootstrap credential is missing or invalid at startup → the system fails
  closed (refuses to start) and serves no protected endpoint; no default credential is used.
- A shop API credential attempts an administrative action (create a shop, or issue/revoke a
  credential) → rejected; administrative actions require separate administrative authorization.
- A catalog price is expressed with a fraction of a cent → rejected; prices must be whole cents.
- An operator tries to create a shop with a slug that already exists → rejected; shop slugs are
  unique and immutable.

## Clarifications

### Session 2026-11-03

- Q: Should each shop store its own named time zone, set when the shop is created? → A: Yes — each
  shop carries a named IANA time zone (e.g. `America/Chicago`), set at creation.
- Q: Is the catalog JSON provided with the brief the authoritative, committed versioned reference
  data? → A: Yes — the provided catalog JSON is the single authoritative source and is committed to
  the repository as the versioned seed of the twelve services.
- Q: How should API credentials per shop work, and is last-used tracking in scope for this slice? →
  A: A shop may hold multiple active credentials; each records a last-used timestamp and is revoked
  individually.
- Q: What form does a shop's identifier take? → A: A unique, immutable, human-readable slug (e.g.
  `rb-downtown`) supplied by the operator at creation.
- Q: What must be true for the system to report "ready" (vs merely "alive")? → A: Readiness passes
  only when the data store is reachable AND the expected schema (migrations) is fully applied; a
  reachable-but-unmigrated instance reports not-ready.
- Q: Must administrative actions (create shop, issue/revoke credential) require their own
  authorization, separate from shop API credentials? → A: Yes — administrative actions require a distinct
  administrative authorization; a shop API credential can never create a shop or create/revoke any
  credential.

### Session 2026-11-03 (gap resolution from foundation checklist)

- Q: How are catalog service codes kept unique, and what is the catalog-version format? → A: Service
  `code` values are unique within a catalog version; the version is a deterministic identifier
  `cat-NNN` (zero-padded, monotonically increasing; the brief's catalog is `cat-001`), minted only
  when the committed catalog content changes. The brief's catalog stays authoritative.
- Q: What happens if the initial administrative credential is missing or invalid? → A: Fail closed —
  the credential comes from configuration, is validated at startup, and no protected endpoint is
  served without it; no default or hardcoded credential exists (CHK007).
- Q: What happens when required migrations or security policies are missing or the schema is
  incompatible? → A: Migrate before serving; fail startup and serve no protected request against an
  incompatible or unpoliced schema (CHK028).
- Q: Can any shop or administrative endpoint be reached unauthenticated? → A: No — all administrative
  and shop-scoped endpoints require authenticated authorization; only liveness/readiness are
  unauthenticated and expose no shop/admin data; public customer intake is a later feature (CHK041).
- Q: Does readiness require more than database reachability? → A: Yes — readiness requires
  reachability AND applied migrations/compatible schema AND valid required configuration AND enforced
  isolation policies; liveness stays independent (CHK042).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST require every shop-scoped request to be authenticated by a credential
  that identifies exactly one shop, and MUST derive the shop identity from that credential — never
  from the request body, path, or any client-supplied value.
- **FR-002**: The system MUST guarantee that a credential for one shop can never read, modify, or
  delete another shop's records, including when another shop's exact record identifiers are supplied.
- **FR-003**: The system MUST enforce shop isolation at the data layer, such that a missing or
  incorrect filter in application logic cannot expose, change, or delete another shop's data.
- **FR-004**: The system MUST include an automated check that fails before release if any category of
  shop-owned data is not covered by an enforced isolation rule.
- **FR-005**: The system MUST allow an operator to create a shop identified by a unique, immutable,
  human-readable slug (e.g. `rb-downtown`) supplied at creation, and MUST reject a slug that is
  already in use.
- **FR-006**: The system MUST record, for each shop, a named IANA time zone set at creation.
- **FR-007**: The system MUST allow an operator to issue one or more API credentials bound to a
  single shop, each of which can be active at the same time.
- **FR-008**: The system MUST display a newly issued credential exactly once and thereafter store only
  a non-reversible fingerprint of it, never the credential value itself.
- **FR-009**: The system MUST allow an operator to revoke an individual credential, after which it can
  no longer authenticate any request, without affecting the shop's other credentials.
- **FR-010**: The system MUST record and update a last-used timestamp for each credential whenever it
  authenticates a request.
- **FR-011**: The system MUST reject any request with a missing, unknown, malformed, or revoked
  credential before accessing any shop data.
- **FR-012**: The system MUST be startable and stoppable on a local machine with a single command each.
- **FR-013**: The system MUST expose a **liveness** signal that reflects *only* whether the process is
  running, and a **separate readiness** signal that reports ready only when **all** of the following
  hold: (a) the data store is reachable; (b) the required migrations are fully applied and the schema
  is **compatible** — the exact set of migrations this build requires is present, with no required
  migration missing and no unknown/newer migration applied; and (c) the required shop-isolation
  policies are **present and forced on every shop-owned (`tenant_id`) table**, verified at runtime by
  inspecting the database's own policy catalog (e.g. `pg_class.relforcerowsecurity` and `pg_policies`),
  not by trusting application code (this runtime check complements the build-time check in FR-004).
  Configuration validity is **not** a readiness check: required configuration is validated once at
  startup and the system refuses to start when it is invalid (FR-014), so a running instance always
  has valid configuration. If any readiness check fails, the system MUST report not-ready with
  machine-readable reasons (`db_unreachable`, `migrations_pending`, `schema_incompatible`,
  `security_policy_missing`), while liveness is unaffected.
- **FR-014**: The system MUST read all configuration from the environment and MUST refuse to start,
  with a clear message naming the missing setting, whenever a required setting is absent or empty.
- **FR-015**: The repository MUST contain no secret values, and this MUST be verifiable by an automated
  scan that reports zero findings.
- **FR-016**: The system MUST provide a single shared catalog of exactly twelve repair services,
  identical for every shop, each with a code, a name, a price, an estimated duration, and a
  requires-inspection flag. These twelve services MUST be loaded from the authoritative catalog data
  provided with the brief, committed to the repository as the single source of the catalog content.
  Service `code` values MUST be unique within a catalog version.
- **FR-017**: The system MUST store every service price as a whole number of cents and MUST reject any
  price that is not a whole number of cents.
- **FR-018**: The system MUST assign each catalog a deterministic, human-readable version identifier of
  the form `cat-NNN` (where `NNN` is a zero-padded, monotonically increasing integer; the brief's
  authoritative catalog is `cat-001`), minted anew only when the committed catalog content changes.
  The system MUST record the catalog version against recorded work so that a later price change never
  alters prices already recorded against earlier work.
- **FR-019**: This feature MUST NOT perform any AI or model processing; all behaviour here is handled by
  deterministic code and configuration.
- **FR-020**: Administrative actions — creating a shop, and issuing or revoking a credential — MUST
  require administrative authorization that is distinct from any shop API credential. A shop API
  credential MUST NOT be able to create a shop or create or revoke any credential.
- **FR-021**: The system MUST obtain its initial administrative credential from configuration
  (environment), validated at startup, and MUST NOT serve any protected (administrative or
  shop-scoped) endpoint unless valid credential configuration is present. The system MUST NOT ship,
  embed, or fall back to any default or hardcoded credential; absence or invalidity of the required
  credential configuration MUST cause the system to **fail closed** (refuse to start, consistent with
  FR-014).
- **FR-022**: The system MUST apply required migrations before serving traffic, and MUST NOT serve
  protected requests when required migrations or required shop-isolation security policies are missing,
  or the schema is incompatible. In that state the system MUST fail startup (preferred); if it is
  already running, it MUST report not-ready and refuse protected requests — never serving against an
  incompatible or unpoliced schema.
- **FR-023**: Every administrative and shop-scoped endpoint MUST require authenticated authorization;
  no shop data or administrative action is reachable unauthenticated. The only unauthenticated
  endpoints are liveness and readiness, which expose neither shop nor administrative data. Public,
  unauthenticated customer intake is out of scope for this feature and is handled in a later feature.

### Key Entities *(include if feature involves data)*

- **Shop (tenant)**: One bike shop in the chain. Identified by a unique, immutable, human-readable
  slug (e.g. `rb-downtown`) supplied at creation; carries a named IANA time zone set at creation and
  an optional human-readable display name (defaulting to the slug); owns all of its own records and is
  the unit of isolation. The scenario includes three shops (`rb-downtown`, `rb-northside`,
  `rb-lakeshore`), but the system can hold more.
- **API Credential** (the canonical term throughout this spec; "API key" is not used as a synonym): A
  secret that authenticates a staff member or system as acting for exactly one shop. A shop may hold
  multiple active credentials. Each is shown once at issue; stored only as a
  fingerprint; has a status (active or revoked) and a last-used timestamp updated on each
  authentication; and is revoked individually. Belongs to exactly one shop.
- **Service (catalog entry)**: A repair service shared by all shops. Attributes: code, name, price in
  whole cents, estimated duration in minutes, and a requires-inspection flag. Carries no shop identity.
- **Catalog version**: The identified set of service prices in effect at a point in time, so recorded
  work can be tied to the prices that applied when it was created.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With two shops provisioned, 100% of cross-shop access attempts (read, modify, delete,
  including by guessing identifiers, and including direct access as the application's own data-store
  role) are denied or return nothing — zero cross-shop leaks.
- **SC-002**: A newly issued credential is shown to the operator exactly once and cannot be retrieved
  in full afterward, in 100% of issues.
- **SC-003**: A revoked credential fails authentication on its next use, 100% of the time.
- **SC-004**: From a clean local checkout, a single command brings the system to a ready state in
  under 2 minutes on a reference developer laptop (≥4 CPU cores, ≥8 GB RAM), and a single command
  shuts it down cleanly.
- **SC-005**: When a required setting is missing or empty, the system refuses to start and names the
  setting, and never starts in a partially-configured state — 100% of such cases.
- **SC-006**: An automated secret scan over the repository reports zero committed secrets.
- **SC-007**: Every shop sees an identical catalog of exactly twelve services — matching the committed
  authoritative catalog data — each priced in whole cents.
- **SC-008**: Liveness and readiness can be queried at any time and are independent: liveness reflects
  only process state, while readiness reports not-ready (with machine-readable reasons) while liveness
  stays alive whenever the data store is unreachable, required migrations are not applied or the schema
  is incompatible, or a required shop-isolation policy is not present and forced. (Invalid
  configuration is handled at startup by FR-014, not by readiness.)
- **SC-009**: When the required administrative credential configuration is missing or invalid, the
  system fails closed and serves no protected endpoint, 100% of the time; no default or hardcoded
  credential is ever accepted.

## Assumptions

- This slice performs no customer message intake and no AI processing; those arrive in later slices
  (intake/queue, AI pipeline, orders, web form, email, resilience, evaluation/deploy).
- The scenario's three shops come from the brief. The twelve-service catalog (with USD prices) is the
  catalog JSON provided with the brief, committed to the repository as the authoritative versioned
  reference data; its concrete codes, names, prices, durations, and inspection flags are taken
  verbatim from that provided data.
- Each shop is assigned a named IANA time zone at creation; a single named zone is assumed for the
  three sample shops unless the brief's data specifies per-shop zones, and the chosen zone(s) are
  documented in the README (REQUIREMENTS Q-TZ).
- "One command" means one documented command to start and one to stop on a developer's laptop; a live
  cloud deployment is out of scope for this slice.
- Credentials in this slice are per-shop and intended for staff and systems; customer-facing links or
  tokens are out of scope here.
- Administrative actions require their own authorization, distinct from shop API credentials (FR-020),
  and the initial administrative credential is supplied via configuration, validated at startup, and
  fail-closed with no default/hardcoded fallback (FR-021). The concrete mechanism and interface for
  that authorization (administrative command versus protected endpoint, and how the administrative
  credential is held) is a technical choice deferred to planning and does not change the requirements
  above.
- All shop-scoped and administrative access requires authenticated authorization (FR-023); the only
  unauthenticated surface is liveness/readiness. No requirement in this feature permits unauthenticated
  shop or administrative access.
- The specific data store, language, framework, and isolation mechanism are deliberately unspecified
  here and are decided in `/speckit-plan`, consistent with `docs/ARCHITECTURE_DECISIONS.md`.
