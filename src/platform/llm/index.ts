/**
 * LlmGateway port (D6). The model only fills a strict form; it returns RAW, UNVALIDATED output that
 * code must validate (I3). No tools, memory, secrets, prices, or shop-list are ever passed to it.
 */
export interface ExtractionInput {
  /** The customer message body. Never logged. */
  content: string;
  /** BCP-47 locale hint for same-language replies (no PII). */
  locale?: string;
  /**
   * The fixed catalog service codes the model may map issues onto (the "fixed 12", FR-002). This is
   * form vocabulary, NOT prices and NOT a shop-list; the fake ignores it. Code still re-validates every
   * returned code against the live catalog (I3), so the model can never widen the set.
   */
  allowedServiceCodes?: readonly string[];
  /** Owning shop id — used by the resilience wrapper for a per-shop bulkhead (007). Never sent to the model. */
  shopId?: string;
}

/** Per-call context the caller may supply — e.g. the shop's LiteLLM virtual key (never the master key). */
export interface ExtractCtx {
  apiKey?: string;
}

export interface LlmGateway {
  readonly name: string;
  /** Returns raw model output (unknown shape) — the caller validates against the schema (I3). */
  extract(input: ExtractionInput, ctx?: ExtractCtx): Promise<unknown>;
  /**
   * Proxy-calculated cost of the most recent successful call, in whole millionths of USD
   * (from `x-litellm-response-cost`). Undefined when the gateway cannot report it (e.g. the fake),
   * in which case the caller settles at its estimate. Never negative.
   */
  readonly lastCostMicros?: number | undefined;
  /** Token usage + model of the most recent successful call, for accounting. Undefined for the fake. */
  readonly lastUsage?: { model: string; promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
}

/**
 * Thrown when the budget authority (the LiteLLM proxy) rejects a call because the shop/team is over
 * its cap — admission denied BEFORE the provider is reached. The pipeline maps this to `held_budget`
 * and does NOT retry (I4, fail-closed). Carries no customer content (VII).
 */
export class BudgetExceededError extends Error {
  constructor(message = 'budget exceeded at the proxy') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** The global "AI paused" switch is on (D13/007). The pipeline parks `held_budget` (honest no-AI hold). */
export class AiPausedError extends Error {
  constructor(message = 'AI processing is paused') {
    super(message);
    this.name = 'AiPausedError';
  }
}

/** The circuit breaker is open after repeated failures (007). Transient → the caller lets pg-boss retry. */
export class CircuitOpenError extends Error {
  constructor(message = 'AI circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** The per-shop bulkhead is full (too many in-flight AI calls for this shop, 007). Transient → retry. */
export class BulkheadFullError extends Error {
  constructor(message = 'per-shop AI concurrency limit reached') {
    super(message);
    this.name = 'BulkheadFullError';
  }
}
