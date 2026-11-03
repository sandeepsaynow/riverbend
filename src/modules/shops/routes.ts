import { z } from 'zod';
import { defineRoute, HttpError, type Router } from '../../platform/http/typed-route.js';
import { requireShopId } from '../../platform/http/tenant-context.js';
import { AuthService, ShopNotFound } from '../auth/index.js';
import { InvalidSlug, InvalidTimeZone, ShopSlugTaken, type ShopsService } from './index.js';

const ShopResponse = z.object({
  id: z.string(),
  slug: z.string(),
  time_zone: z.string(),
  display_name: z.string(),
  created_at: z.unknown(),
});

const CreateShopBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  time_zone: z.string().min(1),
  display_name: z.string().min(1).optional(),
});

const IssuedCredentialResponse = z.object({
  id: z.string(),
  kind: z.literal('shop'),
  shop_id: z.string(),
  prefix: z.string(),
  secret: z.string(),
});

/** Admin provisioning routes (mounted under /admin, behind adminAuth). */
export function registerAdminShopRoutes(
  router: Router,
  deps: { shops: ShopsService; auth: AuthService },
): void {
  defineRoute(router, {
    method: 'post',
    path: '/shops',
    schemas: { body: CreateShopBody, response: ShopResponse },
    handler: async (ctx) => {
      try {
        const shop = await deps.shops.createShop({
          slug: ctx.body.slug,
          timeZone: ctx.body.time_zone,
          // Pass displayName only when present (exactOptionalPropertyTypes: no explicit undefined).
          ...(ctx.body.display_name !== undefined ? { displayName: ctx.body.display_name } : {}),
        });
        return { status: 201, body: shop };
      } catch (err) {
        if (err instanceof ShopSlugTaken) throw new HttpError(409, 'slug_taken', err.message);
        if (err instanceof InvalidTimeZone) throw new HttpError(422, 'invalid_time_zone', err.message);
        if (err instanceof InvalidSlug) throw new HttpError(422, 'invalid_slug', err.message);
        throw err;
      }
    },
  });

  defineRoute(router, {
    method: 'post',
    path: '/shops/:slug/credentials',
    schemas: { params: z.object({ slug: z.string() }), response: IssuedCredentialResponse },
    handler: async (ctx) => {
      try {
        const issued = await deps.auth.issueShopCredential(ctx.params.slug);
        return {
          status: 201,
          body: {
            id: issued.id,
            kind: 'shop',
            shop_id: issued.shopId,
            prefix: issued.prefix,
            secret: issued.token, // shown exactly once (FR-008)
          },
        };
      } catch (err) {
        if (err instanceof ShopNotFound) throw new HttpError(404, 'shop_not_found', err.message);
        throw err;
      }
    },
  });
}

/** Shop-scoped routes (mounted under /v1, behind shopAuth). */
export function registerShopRoutes(router: Router, deps: { shops: ShopsService }): void {
  defineRoute(router, {
    method: 'get',
    path: '/shop',
    schemas: { response: ShopResponse },
    handler: async (ctx) => {
      const shopId = requireShopId(ctx.req); // identity from credential only (FR-001)
      const shop = await deps.shops.getOwnShop(shopId);
      if (!shop) throw new HttpError(404, 'not_found', 'Shop not found');
      return { status: 200, body: shop };
    },
  });
}
