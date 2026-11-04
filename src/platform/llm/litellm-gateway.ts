import type { ExtractionInput, LlmGateway } from './index.js';

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
  'You convert one bike-shop customer message into a strict JSON intake form. Output JSON ONLY.',
  'Schema:',
  '{',
  '  "kind": "repair" | "price_inquiry" | "wrong_shop" | "delegation" | "unclear",',
  '  "bikes": [ { "bikeNumber": <positive int>, "issues": [<string>...],',
  '              "serviceCodes": [<CODE>...], "wheels": ["front"|"rear"...] (optional) } ],',
  '  "urgency": "normal" | "urgent",',
  '  "dateWords": <the customer\'s own date/time words, or null>,',
  '  "questionDraft": <one short clarifying question if the request is ambiguous, else null>',
  '}',
  'Rules: map each repair only to codes from the ALLOWED list below — never invent a code. If no code',
  'clearly applies, leave serviceCodes empty and set kind "unclear". Do not guess prices, dates, or',
  'shops. Report issues in the customer\'s words. Return the JSON object and nothing else.',
].join('\n');

export class LiteLlmGateway implements LlmGateway {
  readonly name = 'litellm';
  /** Usage from the most recent successful call (for smoke tests / cost telemetry). */
  lastUsage: LlmUsage | undefined;

  constructor(
    private readonly config: LiteLlmConfig,
    private readonly logger?: UsageLogger,
  ) {}

  async extract(input: ExtractionInput): Promise<unknown> {
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

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
    });

    if (!res.ok) {
      // Status only — an error body may echo the prompt/content, which must never be logged (VII).
      throw new Error(`LiteLLM proxy returned HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };

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
    // Raw, unvalidated model output: the caller enforces the schema + catalog codes (I3).
    return JSON.parse(text);
  }
}
