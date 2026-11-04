import {
  AiPausedError,
  BulkheadFullError,
  CircuitOpenError,
  type ExtractCtx,
  type ExtractionInput,
  type LlmGateway,
} from './index.js';

export interface ResilienceOptions {
  /** Consecutive failures before the breaker opens. */
  failureThreshold: number;
  /** How long the breaker stays open before a half-open trial (ms). */
  cooldownMs: number;
  /** Max concurrent in-flight calls per shop (bulkhead). */
  maxConcurrentPerShop: number;
  /** Global "AI paused" switch (D13). When it returns true, no model call is attempted. */
  isPaused?: () => boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Resilience wrapper around any `LlmGateway` (007, D13/D15/D16): the global AI-paused switch, a circuit
 * breaker, and a per-shop bulkhead — composed around the delegate's own per-call timeout. It is a
 * two-way-door decorator (Principle IV): it adds failure containment without changing the port.
 * Error mapping (handled by the pipeline): AiPausedError → held_budget; CircuitOpenError /
 * BulkheadFullError / timeouts → thrown so pg-boss (the sole retry authority) retries, then DLQ →
 * needs_review. The breaker protects the provider from a thundering retry herd.
 */
export class ResilientGateway implements LlmGateway {
  readonly name: string;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly inner: LlmGateway,
    private readonly opts: ResilienceOptions,
  ) {
    this.name = `resilient(${inner.name})`;
  }

  get lastCostMicros(): number | undefined {
    return this.inner.lastCostMicros;
  }

  get lastUsage(): { model: string; promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    return this.inner.lastUsage;
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async extract(input: ExtractionInput, ctx?: ExtractCtx): Promise<unknown> {
    if (this.opts.isPaused?.()) throw new AiPausedError();

    // Circuit breaker: refuse fast while open (until the cooldown elapses → one half-open trial).
    if (this.consecutiveFailures >= this.opts.failureThreshold && this.clock() < this.openUntil) {
      throw new CircuitOpenError();
    }

    // Per-shop bulkhead.
    const key = input.shopId ?? '_global';
    const current = this.inFlight.get(key) ?? 0;
    if (current >= this.opts.maxConcurrentPerShop) throw new BulkheadFullError();
    this.inFlight.set(key, current + 1);

    try {
      const out = await this.inner.extract(input, ctx);
      this.consecutiveFailures = 0; // success closes the breaker
      return out;
    } catch (err) {
      this.recordFailure();
      throw err;
    } finally {
      const n = (this.inFlight.get(key) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, n);
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.openUntil = this.clock() + this.opts.cooldownMs;
    }
  }
}
