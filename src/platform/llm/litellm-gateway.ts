import { BudgetExceededError, RateLimitError, type ExtractCtx, type ExtractionInput, type LlmGateway } from './index.js';
import { REQUEST_KINDS } from '../../modules/pipeline/schema.js';

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
  'You convert one bike-shop customer message into a strict JSON intake form, matching the provided JSON',
  'schema exactly. Map each request only to codes from the ALLOWED list in the user message — never invent',
  'a code. Mapping guidance:',
  '- Routine maintenance ("service", "general servicing", "tune-up", "routine/regular maintenance",',
  '  "basic service") → the basic tune-up code (TUNE_BASIC). A clear routine-maintenance request is NOT',
  '  ambiguous just because no specific fault is named — do NOT ask a clarifying question in that case.',
  '- An explicit full/complete overhaul or rebuild → the full-overhaul code (TUNE_FULL). Never choose the',
  '  full overhaul merely because the word "service" appears.',
  '- A request to inspect/diagnose, or a symptom the customer cannot localize ("something feels wrong", "a',
  '  noise I can\'t locate") → the general inspection code (GENERAL_INSPECT).',
  '- A specific fault → its specific service (e.g. brake pads → the brake-pad code), not TUNE_BASIC.',
  '- A price-only question → kind "price_inquiry" (no work order).',
  '- A request to cancel, reschedule, or change an existing order (even "I fixed it myself, cancel it") →',
  '  kind "cancellation" (serviceCodes empty). Never create or cancel an order and never ask a repair',
  '  clarification — a person verifies the request. Do NOT infer which order from the email or wording.',
  'Only when no allowed code applies and the intent is genuinely unclear, leave serviceCodes empty and set',
  'kind "unclear". Do not guess prices, dates, or shops; unknown date → dateWords null (never invent one).',
  'Report issues in the customer\'s own words. If genuinely ambiguous, put one short clarifying question in',
  'questionDraft; otherwise set it null.',
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
          kind: { type: 'string', enum: [...REQUEST_KINDS] }, // single source of truth (schema.ts) — no drift
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
  /** Backing provider model the proxy routed to (from x-litellm-model-name) — real snapshot provenance. */
  lastBackingModel: string | undefined;

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
          // `max_completion_tokens` is the canonical OpenAI ceiling. The GPT-5 family (e.g.
          // gpt-5.4-mini) REJECTS the legacy `max_tokens` with HTTP 400; gpt-4o-mini accepts the new
          // name too, so this single param is correct for both and keeps model rollback config-only.
          max_completion_tokens: this.config.maxOutputTokens ?? 1024,
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
        // Budget is identified by the proxy's error BODY, not the status code alone (D25). A bare 429
        // with no budget marker is a genuine upstream rate-limit → transient (retry), never a budget hold.
        if (/budget/i.test(classify)) {
          throw new BudgetExceededError(`proxy denied admission (HTTP ${res.status})`);
        }
        if (res.status === 429) {
          throw new RateLimitError('LiteLLM proxy rate-limited the request (HTTP 429)');
        }
      }
      // Status only — an error body may echo the prompt/content, which must never be logged (VII).
      throw new Error(`LiteLLM proxy returned HTTP ${res.status}`);
    }

    // Proxy-calculated cost (USD) → whole micros. Absent on some configs → leave undefined (settle est).
    const costHeader = res.headers.get('x-litellm-response-cost');
    const costUsd = costHeader !== null ? Number(costHeader) : NaN;
    this.lastCostMicros = Number.isFinite(costUsd) && costUsd >= 0 ? Math.round(costUsd * 1e6) : undefined;
    // Real backing-model provenance (the alias resolves to e.g. openai/gpt-5.4-mini-2026-03-17).
    this.lastBackingModel = res.headers.get('x-litellm-model-name') ?? this.lastBackingModel;

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
