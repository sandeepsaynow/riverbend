import { z } from 'zod';
import { defineRoute, type Router } from '../../platform/http/typed-route.js';
import type { Db } from '../../platform/db/index.js';
import { checkReadiness } from './readiness.js';

const LivenessResponse = z.object({ status: z.literal('alive') });
const ReadinessResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  reasons: z.array(z.string()).optional(),
});

/** Public health routes (no auth; expose no shop/admin data). FR-013/FR-023. */
export function registerHealthRoutes(router: Router, deps: { db: Db; schemaUrl: string }): void {
  // Liveness: process is up. Independent of readiness — never touches the data store.
  defineRoute(router, {
    method: 'get',
    path: '/healthz',
    schemas: { response: LivenessResponse },
    handler: () => ({ status: 200, body: { status: 'alive' } }),
  });

  // Readiness: reachable + migrated/compatible + isolation policies forced.
  defineRoute(router, {
    method: 'get',
    path: '/readyz',
    schemas: { response: ReadinessResponse },
    handler: async () => {
      const result = await checkReadiness(deps.db, deps.schemaUrl);
      if (result.ready) return { status: 200, body: { status: 'ready' } };
      return { status: 503, body: { status: 'not_ready', reasons: result.reasons } };
    },
  });
}
