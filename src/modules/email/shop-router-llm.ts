import { BudgetExceededError, RateLimitError } from '../../platform/llm/index.js';

/**
 * D34 — LLM-based pre-tenant shop routing. A brand-new email to the single generic address is classified by
 * GPT-5.4 mini into an INTENDED shop + confidence + ambiguity, so contextual preference ("I live Downtown but
 * want Northside" → Northside) is understood where the D32 regex cannot. CRITICAL invariants:
 *   - The model only PROPOSES a shop slug; deterministic CODE validates it against the configured shops and
 *     assigns the tenant. The LLM never sets tenant_id.
 *   - It runs on a SEPARATE, tightly-capped pre-tenant routing key (abuse/spend bound); over-budget, timeout,
 *     invalid schema or low confidence all fall back to the deterministic regex (graceful degradation), then
 *     to pending-intake if still unresolved. No cross-tenant data is read (only the 3 shop slugs are given).
 */
export interface ShopClassification {
  shopSlug: string | null; // a configured slug, or null/'unknown'
  confidence: number; // 0..1
  ambiguous: boolean; // customer named/implied more than one, or contradicted themselves
}

export interface ShopRoutingClassifier {
  classify(text: string, shopSlugs: readonly string[]): Promise<ShopClassification>;
}

export interface LlmRoutingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined; // the DEDICATED, capped pre-tenant routing key (never a per-shop key)
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined; // bounded transient retries (default 1)
}

/** Live classifier: one bounded, strict-JSON-schema call to the LiteLLM proxy. Reads no shop-owned data. */
export class LiteLlmShopRoutingClassifier implements ShopRoutingClassifier {
  constructor(private readonly cfg: LlmRoutingConfig) {}

  async classify(text: string, shopSlugs: readonly string[]): Promise<ShopClassification> {
    const base = this.cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const schema = {
      type: 'json_schema',
      json_schema: {
        name: 'riverbend_shop_routing', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          required: ['intended_shop', 'confidence', 'ambiguous'],
          properties: {
            intended_shop: { type: 'string', enum: [...shopSlugs, 'unknown'] }, // a configured slug or "unknown"
            confidence: { type: 'number' }, // 0..1 the model's certainty in the single intended shop
            ambiguous: { type: 'boolean' }, // more than one shop named/implied, or self-contradiction
          },
        },
      },
    };
    const system = [
      'You route a bike-shop customer email to the ONE location they want service at. Choose from the ALLOWED',
      'shop slugs only. Use the destination they WANT (honour contextual preference over where they live or',
      'ride: "I live downtown but want Northside" → the Northside slug). If they name/imply more than one, or',
      'contradict themselves, set ambiguous=true. If no location is indicated, set intended_shop="unknown".',
      'Never guess; prefer "unknown" over a low-confidence pick. Output only the JSON.',
    ].join(' ');
    const user = `ALLOWED shop slugs: ${shopSlugs.join(', ')}\n\nEmail:\n${text}`;
    const body = JSON.stringify({
      model: this.cfg.model, temperature: 0, max_completion_tokens: 80,
      response_format: schema,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    const maxRetries = this.cfg.maxRetries ?? 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000) });
      } catch (err) {
        lastErr = err; continue; // network/timeout → bounded retry
      }
      if (!res.ok) {
        if (res.status === 422 || res.status === 400 || res.status === 429) {
          let cls = ''; try { cls = await res.text(); } catch { /* ignore */ }
          if (/budget/i.test(cls)) throw new BudgetExceededError(`routing over budget (HTTP ${res.status})`); // fail-closed → caller falls back
          if (res.status === 429) { lastErr = new RateLimitError('routing rate-limited'); continue; }
        }
        lastErr = new Error(`routing HTTP ${res.status}`); continue;
      }
      let parsed: { intended_shop?: unknown; confidence?: unknown; ambiguous?: unknown };
      try {
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        parsed = JSON.parse(j.choices?.[0]?.message?.content ?? '');
      } catch { lastErr = new Error('routing non-JSON/invalid'); continue; }
      const slug = typeof parsed.intended_shop === 'string' && parsed.intended_shop !== 'unknown' ? parsed.intended_shop : null;
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const ambiguous = parsed.ambiguous === true;
      return { shopSlug: slug, confidence, ambiguous };
    }
    throw lastErr instanceof Error ? lastErr : new Error('routing failed');
  }
}

/** Minimal shop directory the resolver needs (kept narrow to avoid a module cycle with ShopsService). */
export interface ShopDirectory {
  listShops(): Promise<Array<{ id: string; slug: string }>>;
  resolveShopByContent(text: string): Promise<string[]>; // deterministic regex fallback (D32)
}

/**
 * D34 resolver wired as the email router's `resolveShopByContent`. LLM-first, CODE-validated, regex-fallback:
 *   1) classify with the LLM; if it returns a CONFIGURED slug, non-ambiguous, confidence ≥ threshold → that
 *      shop (validated in code — the slug must exist).
 *   2) ambiguous → [] (→ pending-intake clarification; never guess).
 *   3) unknown / low-confidence / LLM error / over-budget / timeout → fall back to the deterministic regex.
 * Returns shop ids (0 / 1 / >1); the caller routes on exactly one, else holds the email pending.
 */
export class LlmShopResolver {
  constructor(
    private readonly classifier: ShopRoutingClassifier,
    private readonly dir: ShopDirectory,
    private readonly opts: { minConfidence: number } = { minConfidence: 0.6 },
  ) {}

  async resolve(text: string): Promise<string[]> {
    const shops = await this.dir.listShops();
    const slugs = shops.map((s) => s.slug);
    try {
      const c = await this.classifier.classify(text, slugs);
      if (c.ambiguous) return []; // customer named/implied >1 or contradicted → pending (do not guess)
      if (c.shopSlug && c.confidence >= this.opts.minConfidence) {
        const shop = shops.find((s) => s.slug === c.shopSlug); // code validation: slug must be configured
        if (shop) return [shop.id];
      }
      // 'unknown' or low confidence → try the deterministic regex (it may find a single clear shop name)
    } catch {
      // over-budget / timeout / invalid-schema / network → graceful degradation to the regex
    }
    return this.dir.resolveShopByContent(text);
  }
}
