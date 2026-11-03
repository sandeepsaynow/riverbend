# Feature Specification: Work Orders, Pricing & Staff Reads

**Feature Branch**: `004-orders-staff` | **Created**: 2026-11-03 | **Status**: Draft
**Input**: Slice 004 (D8, D9, D17). From a validated extraction (003), create **one work order per
bike**, all-or-nothing, with prices **computed in code** from the catalog (whole cents), snapshotting
the unit price + catalog version so later price changes never rewrite history. Expose tenant-scoped
staff reads (open orders with totals; needs-attention). Code owns all money.

## User Scenarios & Testing *(mandatory)*

### US1 — One work order per bike, priced in code (P1)
From an `extracted` request, code creates **one work order per bike** in a single transaction, with a
line item per service (quantity × catalog unit price, whole cents). Each item **copies** the unit price
and catalog version at creation. Unique `(shop, request, bike number)` means a replay/redelivery never
creates a duplicate order (**I2**). The model never supplies a price (**I5**).

**Acceptance**:
1. Two bikes in one request → **two** work orders (e.g. m-1040: two tune-ups → USD 65 each = USD 130).
2. Per-wheel service across both wheels → quantity 2 (m-1029: (35+40)×2 = **USD 150**); m-1035 tires ×2.
3. Re-running order creation for the same request creates **no** duplicate orders (I2).
4. Changing a catalog price later leaves existing orders' line prices **unchanged** (snapshot).
5. `requires_inspection` items are included at the listed price, marked "price confirmed after inspection".

### US2 — Tenant-scoped staff reads (P1)
Staff can read their shop's **open work orders** (items + per-order + shop totals) and a
**needs-attention** list (requests in needs_review / awaiting_customer / held_budget). All reads are
RLS-scoped — a shop never sees another shop's orders.

**Acceptance**:
1. Open-orders read returns only this shop's open orders with correct computed totals.
2. Needs-attention returns this shop's waiting/blocked requests with reason + age.
3. Another shop's credential never sees these rows.

### Edge Cases
- Replay of order creation → idempotent (unique (shop, request, bike no.)).
- A catalog code is removed after an order exists → the order keeps its snapshotted price/version.
- `requires_inspection` service → listed price included; flagged for confirmation.
- Cancellation (D9, verified-channel auto-cancel) depends on email (006) → **not built here**; staff
  cancel + the processing race guard are deferred and listed in not-built.

## Requirements *(mandatory)*
- **FR-001**: From an `extracted` request, create **one work order per bike**, all-or-nothing in one
  transaction; set the request to `ordered`. Unique `(shop_id, request_id, bike_number)` (**I2**).
- **FR-002**: Each line item's price MUST be computed in code as `unit_price_cents × quantity` (whole
  cents, **I5**); the model never supplies a price. Quantity for per-wheel services = number of wheels
  named; otherwise the listed count.
- **FR-003**: Each item MUST snapshot the `unit_price_cents`, `catalog_version`, service `name`, and
  `requires_inspection` at creation; later catalog changes MUST NOT alter existing items.
- **FR-004**: `requires_inspection` items MUST be included at the listed price and marked for
  post-inspection confirmation.
- **FR-005**: Order creation MUST be idempotent — a redelivered/replayed job creates no duplicate order
  (relies on the unique key; no second charge of work).
- **FR-006**: A tenant-scoped read MUST list a shop's **open** work orders with per-order and shop
  totals; a tenant-scoped read MUST list **needs-attention** requests (needs_review / awaiting_customer
  / held_budget) with reason + age.
- **FR-007**: All order and staff-read operations MUST be RLS-isolated per shop (001). Money stays whole
  integer cents; totals are computed, never model-supplied.
- **FR-008**: This slice does NOT send email and does NOT perform verified-channel cancellation (006);
  the AI pipeline (003) is unchanged.

## Key Entities
- **Work order**: one per (shop, request, bike number); status open|cancelled. Shop-owned.
- **Work order item**: snapshot of a catalog service on an order — code, name, unit_price_cents,
  quantity, line_total_cents, catalog_version, requires_inspection.

## Success Criteria
- **SC-001**: m-1029 → USD 150; m-1040 → two orders USD 65 each (USD 130); m-1035 → tire ×2 — computed in code, 100%.
- **SC-002**: Replaying order creation yields exactly one order per bike (I2), 100%.
- **SC-003**: A catalog price change leaves existing order items unchanged, 100%.
- **SC-004**: Open-orders + needs-attention reads return only the owning shop's rows (RLS), 100%.
- **SC-005**: No price is model-supplied; all totals are code-computed whole cents.

## Assumptions
- Builds on 001/002/003. Order creation runs in the worker after a request reaches `extracted`.
- Quantity derivation: per-wheel services (BRAKE_ADJUST/PADS/BLEED, FLAT_FIX, TIRE_REPLACE, WHEEL_TRUE)
  → number of wheels; others → listed count. (Decision logged.)
- Cancellation + server-rendered staff HTML (D17) are deferred (staff reads exposed as JSON); documented
  in not-built. "Open" = work order status `open`.
