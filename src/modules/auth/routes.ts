import { z } from 'zod';
import { defineRoute, HttpError, type Router } from '../../platform/http/typed-route.js';
import type { AuthService } from './index.js';

/** Admin credential routes (mounted under /admin, behind adminAuth). */
export function registerAdminCredentialRoutes(router: Router, deps: { auth: AuthService }): void {
  defineRoute(router, {
    method: 'post',
    path: '/credentials/:id/revoke',
    schemas: {
      params: z.object({ id: z.string().uuid() }),
      response: z.unknown(),
    },
    handler: async (ctx) => {
      const revoked = await deps.auth.revokeCredential(ctx.params.id);
      if (!revoked) throw new HttpError(404, 'credential_not_found', 'No active credential with that id');
      return { status: 204, body: undefined };
    },
  });
}
