import { z } from 'zod';
import { defineRoute, type Router } from '../../platform/http/typed-route.js';
import type { CatalogService } from './index.js';

const CatalogResponse = z.object({
  catalog_version: z.string(),
  services: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      price_cents: z.number().int(),
      minutes: z.number().int(),
      requires_inspection: z.boolean(),
    }),
  ),
});

/** Shop-scoped catalog read (mounted under /v1, behind shopAuth). */
export function registerCatalogRoutes(router: Router, deps: { catalog: CatalogService }): void {
  defineRoute(router, {
    method: 'get',
    path: '/catalog',
    schemas: { response: CatalogResponse },
    handler: async () => {
      const catalog = await deps.catalog.getCatalog();
      return { status: 200, body: catalog };
    },
  });
}
