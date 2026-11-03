/**
 * Request lifecycle for slice 002 (no AI). The worker advances received → processing →
 * awaiting_pipeline (terminal-for-002 success). pg-boss drives retries/redelivery; on attempt
 * exhaustion the request parks in needs_review. Slice 003 replaces the deterministic step with the
 * AI pipeline.
 */
export const REQUEST_STATES = [
  'received',
  'processing',
  'awaiting_pipeline',
  'needs_review',
] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

export const MESSAGE_SOURCES = ['email', 'web', 'api'] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];
