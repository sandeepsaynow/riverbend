import { z } from 'zod';
import { defineRoute, type Router } from '../../platform/http/typed-route.js';
import { requireShopId } from '../../platform/http/tenant-context.js';
import type { OrdersService } from './index.js';

const OrdersResponse = z.object({ orders: z.array(z.unknown()), shop_total_cents: z.number().int() });
const NeedsAttentionResponse = z.object({ items: z.array(z.unknown()) });

/** Tenant-scoped staff reads (mounted under /v1, behind shopAuth). */
export function registerOrdersRoutes(router: Router, deps: { orders: OrdersService }): void {
  defineRoute(router, {
    method: 'get',
    path: '/orders',
    schemas: { response: OrdersResponse },
    handler: async (ctx) => {
      const shopId = requireShopId(ctx.req);
      return { status: 200, body: await deps.orders.listOpenOrders(shopId) };
    },
  });

  defineRoute(router, {
    method: 'get',
    path: '/needs-attention',
    schemas: { response: NeedsAttentionResponse },
    handler: async (ctx) => {
      const shopId = requireShopId(ctx.req);
      return { status: 200, body: { items: await deps.orders.needsAttention(shopId) } };
    },
  });
}
