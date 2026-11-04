/**
 * JobQueue port (D4, Principle IV). The queue is a doorbell: payloads carry **ids only** (the D2
 * cross-shop exception). pg-boss is the single retry authority (configured in the adapter); the
 * application never re-enqueues processing work.
 */
export interface JobPayload {
  requestId: string;
  shopId: string;
}

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Publish a job to the named queue (the relay's only queue write). */
  publish(name: string, payload: JobPayload): Promise<void>;
  /** Register a handler for the named queue. Handler runs once per job. */
  work(name: string, handler: (payload: JobPayload) => Promise<void>): Promise<void>;
}

/** The intake processing queue, and its dead-letter queue (exhausted jobs land here). */
export const INTAKE_QUEUE = 'intake-process';
export const INTAKE_DLQ = 'intake-process-dlq';
/** The AI-pipeline queue (slice 003), fed after intake reaches awaiting_pipeline. */
export const PIPELINE_QUEUE = 'ai-pipeline';
export const PIPELINE_DLQ = 'ai-pipeline-dlq';
/** Inbound email polling trigger (006/D21.1): a self-rescheduling singleton job (no request payload). */
export const EMAIL_POLL_QUEUE = 'email-poll';
