import { BudgetExceededError, type ExtractCtx, type ExtractionInput, type LlmGateway } from './index.js';

/**
 * Real provider adapter (D6): all model traffic goes through a LiteLLM proxy (digest-pinned,
 * internal-only) behind this `LlmGateway` port. The proxy owns the backing-provider key (OpenAI,
 * Vertex, …) and routing; this adapter never sees that key — it authenticates to the *proxy* with an
 * optional proxy key. The model only fills a strict form (FR-002): no tools, memory, secrets, prices,
 * or shop-list — only the message and the fixed service-code vocabulary. Output is returned RAW and
 * UNVALIDATED; the caller validates it against the schema (I3).
 */
export interface LiteLlmConfig {
  baseUrl?: string | undefined;
  model?: string | undefined;
  /** Proxy key (LiteLLM master/virtual key), NOT the backing-provider key. Optional for local runs. */
  apiKey?: string | undefined;
  /** Per-call wall-clock budget (ms); the breaker/bulkhead around this lands in slice 007. */
  timeoutMs?: number | undefined;
  /** Strict output-token ceiling per call (bounds cost + soft-cap overshoot). Default 1024. */
  maxOutputTokens?: number | undefined;
}

/** Usage metrics for a single call — token counts only, never message content (VII, ids-only logging). */
export interface LlmUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Minimal structural logger so the adapter stays decoupled from the pino wrapper. */
interface UsageLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

const SYSTEM_PROMPT = [
  'You convert one bike-shop customer message into a strict JSON intake form, matching the provided',
  'JSON schema exactly. Map each repair only to codes from the ALLOWED list in the user message — never',
  'invent a code. If no allowed code clearly applies, leave serviceCodes empty and set kind "unclear".',
  'Do not guess prices, dates, or shops. Report issues in the customer\'s own words. If the request is',
  'ambiguous, put one short clarifying question in questionDraft; otherwise set it null.',
].join('\n');

/** Build the strict JSON-schema response_format (I3 safety-net still re-validates in code). */
function responseFormat(allowed: readonly string[]): Record<string, unknown> {
  const serviceCodes =
    allowed.length > 0
      ? { type: 'array', items: { type: 'string', enum: [...allowed] } }
      : { type: 'array', items: { type: 'string' } };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'riverbend_extraction',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'bikes', 'urgency', 'dateWords', 'questionDraft'],
        properties: {
          kind: { type: 'string', enum: ['repair', 'price_inquiry', 'wrong_shop', 'delegation', 'unclear'] },
          bikes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['bikeNumber', 'issues', 'serviceCodes', 'wheels'],
              properties: {
                bikeNumber: { type: 'integer' },
                issues: { type: 'array', items: { type: 'string' } },
                serviceCodes,
                wheels: { type: 'array', items: { type: 'string', enum: ['front', 'rear'] } },
              },
            },
          },
          urgency: { type: 'string', enum: ['normal', 'urgent'] },
          dateWords: { type: ['string', 'null'] },
          questionDraft: { type: ['string', 'null'] },
        },
      },
    },
  };
}

export class LiteLlmGateway implements LlmGateway {
  readonly name = 'litellm';
  /** Usage from the most recent successful call (for smoke tests / cost telemetry). */
  lastUsage: LlmUsage | undefined;
  /** Proxy-calculated cost of the most recent call in whole micros (from x-litellm-response-cost). */
  lastCostMicros: number | undefined;

  constructor(
    private readonly config: LiteLlmConfig,
    private readonly logger?: UsageLogger,
  ) {}

  async extract(input: ExtractionInput, ctx?: ExtractCtx): Promise<unknown> {
    if (!this.config.baseUrl || !this.config.model) {
      throw new Error(
        'LiteLLM gateway not configured (LLM_BASE_URL / LLM_MODEL). Provide the proxy endpoint to ' +
          'enable the real provider (blocker B1). Tests and local demo use the FakeGateway.',
      );
    }

    const allowed = input.allowedServiceCodes ?? [];
    const user = allowed.length
      ? `ALLOWED service codes: ${allowed.join(', ')}\n\nMessage:\n${input.content}`
      : `Message:\n${input.content}`;

    // Per-call key (the shop's virtual key) overrides the configured key; never the master key.
    const apiKey = ctx?.apiKey ?? this.config.apiKey;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    // Tolerate a base URL that already ends in /v1 (LLM_BASE_URL=http://litellm:4000/v1) or one that
    // does not — always resolve to a single /v1/chat/completions.
    const base = this.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

    let res: Response;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: this.config.maxOutputTokens ?? 1024,
          response_format: responseFormat(allowed),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });
    } catch (err) {
      // Timeout (AbortSignal) or network failure. Message only — never the prompt/content (VII).
      const kind = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error';
      throw new Error(`LiteLLM proxy request failed (${kind})`);
    }

    if (!res.ok) {
      // Budget rejection (I4, fail-closed): LiteLLM denies admission over cap with HTTP 422 (also seen
      // as 400/429 on some setups), carrying error type "budget_exceeded". We read the error body ONLY
      // to classify it and NEVER log it (a budget error carries no customer content, VII).
      if (res.status === 422 || res.status === 400 || res.status === 429) {
        let classify = '';
        try { classify = await res.text(); } catch { /* ignore */ }
        if (res.status === 429 || /budget/i.test(classify)) {
          throw new BudgetExceededError(`proxy denied admission (HTTP ${res.status})`);
        }
      }
      // Status only — an error body may echo the prompt/content, which must never be logged (VII).
      throw new Error(`LiteLLM proxy returned HTTP ${res.status}`);
    }

    // Proxy-calculated cost (USD) → whole micros. Absent on some configs → leave undefined (settle est).
    const costHeader = res.headers.get('x-litellm-response-cost');
    const costUsd = costHeader !== null ? Number(costHeader) : NaN;
    this.lastCostMicros = Number.isFinite(costUsd) && costUsd >= 0 ? Math.round(costUsd * 1e6) : undefined;

    let body: {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error('LiteLLM proxy returned a non-JSON response');
    }

    const u = body.usage ?? {};
    this.lastUsage = {
      model: body.model ?? this.config.model,
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
    };
    // Metrics only — no message content, no completion text (VII, ids-only logging).
    this.logger?.info({ gateway: this.name, ...this.lastUsage }, 'llm extraction');

    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new Error('LiteLLM proxy returned no message content');
    }
    try {
      // Raw, unvalidated model output: the caller enforces the schema + catalog codes (I3).
      return JSON.parse(text);
    } catch {
      throw new Error('LiteLLM proxy returned malformed JSON content');
    }
  }
}
