# Implementation Plan: Work Orders, Pricing & Staff Reads (004)

**Branch**: `004-orders-staff` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

## Summary
After a request reaches `extracted` (003), the worker runs an orders step: `OrdersService` creates one
work order per bike in a single transaction, computing each line as `catalog unit_price_cents ×
quantity` (whole cents, I5) and snapshotting price + catalog version + name + inspection flag; unique
`(shop, request, bike_number)` makes it idempotent (I2). Request → `ordered`. Tenant-scoped JSON reads
expose open orders (with totals) and needs-attention. No email/cancel (006/deferred). Reuses 001/002/003.

## Constitution Check
- **I5** price in code (whole cents), snapshotted; **I2** one order per bike (unique key) — each tested.
- **III** new tables shop_id + forced RLS + composite FKs; **VII** no message text logged; **VIII** real-PG tests. Code owns money (I). **Gate: PASS.**

## Structure (additions)
```
src/modules/orders/
  index.ts     # OrdersService: createFromExtraction (idempotent), listOpenOrders, needsAttention, pricing
  routes.ts    # GET /v1/orders, GET /v1/needs-attention (shopAuth)
src/migrations/5000_orders.cjs   # work_orders, work_order_items + RLS + composite FKs; request states ordered/cancelled
```
Worker PIPELINE_QUEUE handler: after `pipeline.run`, if request is `extracted` → `orders.createFromExtraction` → `ordered`.

## Deferred (not-built this slice; logged)
Verified-channel cancellation + the cancel/processing race (D9, needs email/006); server-rendered staff
HTML pages (D17) — staff data is exposed as JSON reads instead.
