import { describe, it, expect, afterEach, vi } from 'vitest';
import { LiteLlmGateway } from '../../src/platform/llm/litellm-gateway.js';

// D26 model upgrade (gpt-4o-mini → gpt-5.4-mini): the GPT-5 family REJECTS the legacy `max_tokens`
// parameter with HTTP 400 ("use 'max_completion_tokens' instead"). This pins the request shape so a
// future edit can't silently reintroduce `max_tokens` and break the production model.
const CFG = { baseUrl: 'http://litellm:4000', model: 'riverbend-extraction', maxOutputTokens: 800 };
const input = { content: 'brake service', allowedServiceCodes: ['TUNE_BASIC'], shopId: 's-1' };

const okResponse = (): Response =>
  new Response(JSON.stringify({ model: 'riverbend-extraction', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [{ message: { content: '{"kind":"repair","bikes":[],"urgency":"normal","dateWords":null,"questionDraft":null}' } }] }), {
    status: 200,
    headers: { 'x-litellm-response-cost': '0.0004', 'x-litellm-model-name': 'openai/gpt-5.4-mini-2026-03-17' },
  });

afterEach(() => { vi.restoreAllMocks(); });

describe('LiteLlmGateway request shape (GPT-5 compatibility)', () => {
  it('sends max_completion_tokens (not legacy max_tokens) so the GPT-5 family accepts the call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    await new LiteLlmGateway(CFG).extract(input);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.max_completion_tokens).toBe(800);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('captures the backing model snapshot from x-litellm-model-name (real provenance)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const gw = new LiteLlmGateway(CFG);
    await gw.extract(input);
    expect(gw.lastBackingModel).toBe('openai/gpt-5.4-mini-2026-03-17');
    expect(gw.lastCostMicros).toBe(400);
  });
});
