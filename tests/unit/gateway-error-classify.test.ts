import { describe, it, expect, afterEach, vi } from 'vitest';
import { LiteLlmGateway } from '../../src/platform/llm/litellm-gateway.js';
import { BudgetExceededError, RateLimitError } from '../../src/platform/llm/index.js';

// D25 — a proxy 429 must be classified by the error BODY, not the status alone: a real budget rejection
// (body says "budget") parks held_budget and is NOT retried, while a genuine upstream rate-limit (bare 429)
// is transient and MUST be retried. Previously ANY 429 was forced to BudgetExceededError.
const CFG = { baseUrl: 'http://litellm:4000', model: 'riverbend-extraction' };
const input = { content: 'brake service', allowedServiceCodes: [], shopId: 's-1' };
const reply = (status: number, body: string): Response => new Response(body, { status });

afterEach(() => { vi.restoreAllMocks(); });

describe('LiteLlmGateway error classification', () => {
  it('429 whose body names a budget → BudgetExceededError (fail-closed hold, no retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(429, '{"error":{"message":"ExceededBudget: team budget exceeded"}}'));
    await expect(new LiteLlmGateway(CFG).extract(input)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('a bare 429 rate-limit (no budget marker) → RateLimitError (transient → retried, never held_budget)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(429, '{"error":{"message":"Rate limit reached for requests"}}'));
    const err = await new LiteLlmGateway(CFG).extract(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(BudgetExceededError);
  });

  it('422 budget rejection → BudgetExceededError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(422, 'budget_exceeded for team'));
    await expect(new LiteLlmGateway(CFG).extract(input)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('503 upstream outage → generic transient Error (retried), not a budget hold', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(503, 'upstream unavailable'));
    const err = await new LiteLlmGateway(CFG).extract(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toMatch(/HTTP 503/);
  });
});
