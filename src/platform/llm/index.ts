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
}

export interface LlmGateway {
  readonly name: string;
  /** Returns raw model output (unknown shape) — the caller validates against the schema (I3). */
  extract(input: ExtractionInput): Promise<unknown>;
  /**
   * Proxy-calculated cost of the most recent successful call, in whole millionths of USD
   * (from `x-litellm-response-cost`). Undefined when the gateway cannot report it (e.g. the fake),
   * in which case the caller settles at its estimate. Never negative.
   */
  readonly lastCostMicros?: number | undefined;
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
