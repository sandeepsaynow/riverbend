import type { Db, PoolClient } from '../../platform/db/index.js';
import { contentFingerprint } from './canonical.js';
import type { MessageSource, RequestState } from './state.js';

export const MAX_CONTENT_CHARS = 20_000;

export class ConflictError extends Error {} // same identifier, different content → 409
export class ValidationError extends Error {} // bad input → 422

export interface SubmitInput {
  shopId: string;
  source: MessageSource;
  submissionId: string;
  content: string;
  /** Customer reply path (I8); mandatory for the web source, optional elsewhere. Never logged (VII). */
  customerEmail?: string;
}

export interface SubmitResult {
  requestId: string;
  state: RequestState;
  statusUrl: string;
  duplicate: boolean; // true when this submission replayed an existing request
}

export interface RequestStatus {
  request_id: string;
  state: RequestState;
  source: MessageSource;
  submission_id: string;
  received_at: string;
}

export class IntakeService {
  constructor(private readonly db: Db) {}

  /**
   * Accept a message. Idempotency keyed ONLY on (shop, source, submission_id); identical re-send
   * replays the existing request, same key + different canonical content → 409, different keys always
   * distinct (FR-005/006/007/015). Message + request + job_outbox are written in one transaction
   * (FR-002). The request id is the tracking reference.
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    if (!input.submissionId || input.submissionId.trim() === '') {
      throw new ValidationError('submission_id is required');
    }
    if (input.content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(`content exceeds ${MAX_CONTENT_CHARS} characters`);
    }
    const fingerprint = contentFingerprint(input.content);

    return this.db.withTenant(input.shopId, async (client: PoolClient) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (shop_id, source, submission_id, content, content_fingerprint, customer_email)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (shop_id, source, submission_id) DO NOTHING
         RETURNING id`,
        [input.shopId, input.source, input.submissionId, input.content, fingerprint, input.customerEmail ?? null],
      );

      if (inserted.rows.length > 0) {
        // New logical submission.
        const messageId = inserted.rows[0]!.id;
        const req = await client.query<{ id: string }>(
          `INSERT INTO requests (shop_id, message_id, state) VALUES ($1, $2, 'received') RETURNING id`,
          [input.shopId, messageId],
        );
        const requestId = req.rows[0]!.id;
        await client.query(
          `INSERT INTO job_outbox (shop_id, request_id, status) VALUES ($1, $2, 'pending')`,
          [input.shopId, requestId],
        );
        return { requestId, state: 'received', statusUrl: statusUrl(requestId), duplicate: false };
      }

      // Idempotency key already exists → compare canonical fingerprint.
      const existing = await client.query<{
        message_id: string;
        fingerprint: Buffer;
        request_id: string;
        state: RequestState;
      }>(
        `SELECT m.id AS message_id, m.content_fingerprint AS fingerprint,
                r.id AS request_id, r.state AS state
           FROM messages m JOIN requests r ON r.message_id = m.id
          WHERE m.shop_id = $1 AND m.source = $2 AND m.submission_id = $3`,
        [input.shopId, input.source, input.submissionId],
      );
      const row = existing.rows[0];
      if (!row) {
        // Should not happen (conflict implies the row exists); treat as transient.
        throw new ConflictError('idempotency conflict could not be resolved; retry');
      }
      if (Buffer.compare(fingerprint, row.fingerprint) !== 0) {
        throw new ConflictError('submission_id reused with different content');
      }
      return {
        requestId: row.request_id,
        state: row.state,
        statusUrl: statusUrl(row.request_id),
        duplicate: true,
      };
    });
  }

  /** Read a request's current state by reference, scoped to the owning shop (RLS). */
  async getRequestStatus(shopId: string, requestId: string): Promise<RequestStatus | null> {
    return this.db.withTenant(shopId, async (client) => {
      const res = await client.query<RequestStatus>(
        `SELECT r.id AS request_id, r.state AS state,
                m.source AS source, m.submission_id AS submission_id, m.received_at AS received_at
           FROM requests r JOIN messages m ON m.id = r.message_id
          WHERE r.id = $1`,
        [requestId],
      );
      return res.rows[0] ?? null;
    });
  }
}

function statusUrl(requestId: string): string {
  return `/v1/requests/${requestId}`;
}
