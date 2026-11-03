import type { ExtractionInput, LlmGateway } from './index.js';

/**
 * Real provider adapter (D6): all model traffic through a LiteLLM proxy (digest-pinned, internal-only)
 * to a Vertex AI "Flash-class" model, strict JSON schema response, no prices/tools/secrets in the
 * prompt. Requires configuration (`LLM_BASE_URL`, model name, Vertex service account) — a paid service
 * and secret. Until those are provided (blocker B1) this adapter refuses to run rather than pretend.
 */
export interface LiteLlmConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export class LiteLlmGateway implements LlmGateway {
  readonly name = 'litellm';
  constructor(private readonly config: LiteLlmConfig) {}

  async extract(_input: ExtractionInput): Promise<unknown> {
    if (!this.config.baseUrl || !this.config.model) {
      throw new Error(
        'LiteLLM gateway not configured (LLM_BASE_URL / LLM_MODEL). Provide credentials to enable the ' +
          'real provider (blocker B1). Tests and local demo use the FakeGateway.',
      );
    }
    // Real call intentionally not implemented without a configured, credentialed proxy (B1):
    // POST {baseUrl}/v1/chat/completions with a strict JSON-schema response_format, parse → return raw.
    throw new Error('LiteLLM real call path pending credentialed proxy (B1).');
  }
}
