import { z } from 'zod';
import { defineRoute, HttpError, type Router } from '../../platform/http/typed-route.js';
import { requireShopId } from '../../platform/http/tenant-context.js';
import { ConflictError, IntakeService, MAX_CONTENT_CHARS, ValidationError } from './index.js';
import { MESSAGE_SOURCES } from './state.js';

const SubmitBody = z.object({
  source: z.enum(MESSAGE_SOURCES),
  submission_id: z.string().min(1),
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  received_at: z.string().datetime().optional(),
});

const Acknowledgement = z.object({
  request_id: z.string(),
  state: z.string(),
  status_url: z.string(),
});

const RequestStatusResponse = z.object({
  request_id: z.string(),
  state: z.string(),
  source: z.string(),
  submission_id: z.string(),
  received_at: z.unknown(),
});

/** Shop-scoped intake routes (mounted under /v1, behind shopAuth). */
export function registerIntakeRoutes(router: Router, deps: { intake: IntakeService }): void {
  defineRoute(router, {
    method: 'post',
    path: '/messages',
    schemas: { body: SubmitBody, response: Acknowledgement },
    handler: async (ctx) => {
      const shopId = requireShopId(ctx.req); // identity from the credential only (FR-001)
      try {
        const result = await deps.intake.submit({
          shopId,
          source: ctx.body.source,
          submissionId: ctx.body.submission_id,
          content: ctx.body.content,
        });
        // 202 Accepted (HTTP status) — distinct from the internal `awaiting_pipeline` state.
        return {
          status: 202,
          body: { request_id: result.requestId, state: result.state, status_url: result.statusUrl },
        };
      } catch (err) {
        if (err instanceof ConflictError) throw new HttpError(409, 'idempotency_conflict', err.message);
        if (err instanceof ValidationError) throw new HttpError(422, 'invalid_submission', err.message);
        throw err;
      }
    },
  });

  defineRoute(router, {
    method: 'get',
    path: '/requests/:id',
    schemas: { params: z.object({ id: z.string().uuid() }), response: RequestStatusResponse },
    handler: async (ctx) => {
      const shopId = requireShopId(ctx.req);
      const status = await deps.intake.getRequestStatus(shopId, ctx.params.id);
      if (!status) throw new HttpError(404, 'not_found', 'No such request for this shop');
      return { status: 200, body: status };
    },
  });
}
