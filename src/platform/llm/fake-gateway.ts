import type { ExtractionInput, LlmGateway } from './index.js';

/**
 * Deterministic, offline fake model server for tests and local demo (Constitution VIII allows a
 * controllable fake AI server). It maps message keywords to a canned raw form — including deliberately
 * invalid output — so the pipeline's validation (I3) and decision paths are exercised without a key.
 * It is NOT the real provider; the real LiteLLM/Vertex adapter (D6) is gated on credentials (B1).
 */
export class FakeGateway implements LlmGateway {
  readonly name = 'fake';

  async extract(input: ExtractionInput): Promise<unknown> {
    const text = input.content.toLowerCase();

    if (text.includes('__bad_json__')) return { not: 'a valid form' };
    if (text.includes('__bad_code__')) {
      return form('repair', [{ bikeNumber: 1, issues: ['mystery'], serviceCodes: ['NOPE_NOT_A_CODE'] }]);
    }
    if (text.includes('how much') || text.includes('price') || text.includes('cost')) {
      return form('price_inquiry', []);
    }
    if (text.includes('wrong shop') || text.includes('lakeshore team')) return form('wrong_shop', []);
    if (text.includes('whatever it needs') || text.includes('whatever you think')) {
      return form('delegation', []);
    }
    if (text.includes('tune')) {
      return form('repair', [{ bikeNumber: 1, issues: ['needs a tune-up'], serviceCodes: ['TUNE_BASIC'] }]);
    }
    if (text.includes('brake') && (text.includes('pad') || text.includes('bleed'))) {
      return form('repair', [
        { bikeNumber: 1, issues: ['brake service'], serviceCodes: ['BRAKE_PADS', 'BRAKE_BLEED'], wheels: ['front', 'rear'] },
      ]);
    }
    if (text.includes('brake')) {
      // Ambiguous: a brake issue but no clear service → code should ask one question.
      return { kind: 'unclear', bikes: [{ bikeNumber: 1, issues: ['brakes'], serviceCodes: [] }], urgency: 'normal', dateWords: null, questionDraft: 'Which brake service would you like?' };
    }
    return { kind: 'unclear', bikes: [], urgency: 'normal', dateWords: null, questionDraft: null };
  }
}

function form(kind: string, bikes: Array<Record<string, unknown>>): unknown {
  return { kind, bikes, urgency: 'normal', dateWords: null, questionDraft: null };
}
