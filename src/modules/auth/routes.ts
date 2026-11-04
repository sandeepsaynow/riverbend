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

  // Rotate a shop credential (009 FR-003): revoke the old, issue a replacement (same shop + scopes).
  defineRoute(router, {
    method: 'post',
    path: '/credentials/:id/rotate',
    schemas: {
      params: z.object({ id: z.string().uuid() }),
      response: z.object({ id: z.string(), kind: z.literal('shop'), shop_id: z.string(), prefix: z.string(), secret: z.string(), scopes: z.array(z.string()), expires_at: z.string().nullable() }),
    },
    handler: async (ctx) => {
      const issued = await deps.auth.rotateCredential(ctx.params.id);
      if (!issued) throw new HttpError(404, 'credential_not_found', 'No shop credential with that id');
      return {
        status: 201,
        body: { id: issued.id, kind: 'shop', shop_id: issued.shopId, prefix: issued.prefix, secret: issued.token, scopes: issued.scopes, expires_at: issued.expiresAt },
      };
    },
  });
}
