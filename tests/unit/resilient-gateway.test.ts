import { describe, it, expect } from 'vitest';
import { ResilientGateway } from '../../src/platform/llm/resilient-gateway.js';
import { AiPausedError, BulkheadFullError, CircuitOpenError, type ExtractionInput, type LlmGateway } from '../../src/platform/llm/index.js';

class CountingGateway implements LlmGateway {
  readonly name = 'counting';
  calls = 0;
  lastCostMicros: number | undefined;
  constructor(private readonly behavior: (call: number) => unknown) {}
  async extract(_input: ExtractionInput): Promise<unknown> {
    this.calls += 1;
    this.lastCostMicros = 42;
    const out = this.behavior(this.calls);
    if (out instanceof Error) throw out;
    return out;
  }
}

describe('007 ResilientGateway', () => {
  it('throws AiPausedError without calling the delegate when paused', async () => {
    const inner = new CountingGateway(() => ({}));
    const g = new ResilientGateway(inner, { failureThreshold: 3, cooldownMs: 100, maxConcurrentPerShop: 4, isPaused: () => true });
    await expect(g.extract({ content: 'x' })).rejects.toBeInstanceOf(AiPausedError);
    expect(inner.calls).toBe(0);
  });

  it('opens the circuit after N consecutive failures, then half-opens after the cooldown', async () => {
    let t = 1000;
    const inner = new CountingGateway((n) => (n <= 2 ? new Error('boom') : { ok: true }));
    const g = new ResilientGateway(inner, { failureThreshold: 2, cooldownMs: 100, maxConcurrentPerShop: 4, now: () => t });
    await expect(g.extract({ content: 'x' })).rejects.toThrow('boom'); // fail 1
    await expect(g.extract({ content: 'x' })).rejects.toThrow('boom'); // fail 2 → opens
    await expect(g.extract({ content: 'x' })).rejects.toBeInstanceOf(CircuitOpenError); // open, delegate not called
    expect(inner.calls).toBe(2);
    t = 1200; // past cooldown → half-open trial
    await expect(g.extract({ content: 'x' })).resolves.toEqual({ ok: true });
    expect(inner.calls).toBe(3);
    // success resets: a later failure alone does not immediately re-open
    await expect(g.extract({ content: 'x' })).resolves.toEqual({ ok: true });
  });

  it('enforces a per-shop bulkhead on concurrent calls', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const inner: LlmGateway = { name: 'blocking', async extract() { return new Promise((r) => resolvers.push(r)); } };
    const g = new ResilientGateway(inner, { failureThreshold: 3, cooldownMs: 100, maxConcurrentPerShop: 1 });
    const first = g.extract({ content: 'x', shopId: 's1' }); // occupies the single slot (pending)
    await expect(g.extract({ content: 'x', shopId: 's1' })).rejects.toBeInstanceOf(BulkheadFullError);
    const other = g.extract({ content: 'x', shopId: 's2' }); // a different shop is unaffected
    resolvers.forEach((r) => r({ ok: true }));
    await expect(first).resolves.toEqual({ ok: true });
    await expect(other).resolves.toEqual({ ok: true });
  });

  it('passes through the delegate lastCostMicros', async () => {
    const inner = new CountingGateway(() => ({}));
    const g = new ResilientGateway(inner, { failureThreshold: 3, cooldownMs: 100, maxConcurrentPerShop: 4 });
    await g.extract({ content: 'x' });
    expect(g.lastCostMicros).toBe(42);
  });
});
