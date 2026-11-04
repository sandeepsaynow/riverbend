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
    const has = (...ks: string[]): boolean => ks.some((k) => text.includes(k));

    if (text.includes('__bad_json__')) return { not: 'a valid form' };
    if (text.includes('__bad_code__')) {
      return form('repair', [{ bikeNumber: 1, issues: ['mystery'], serviceCodes: ['NOPE_NOT_A_CODE'] }]);
    }
    // Price-only question → no work order (checked before service mapping so "how much for an overhaul?" is a quote).
    if (has('how much', 'price', 'cost', 'quote', 'how expensive')) return form('price_inquiry', []);
    // Cancel/change an existing order (D23) → kind 'cancellation' → decide() routes to needs_review
    // (a person verifies ownership); NEVER a new/auto-cancelled order and NEVER a repair clarification.
    if (has('cancel', 'reschedule')) {
      return form('cancellation', [{ bikeNumber: 1, issues: ['wants to cancel or change an existing order'], serviceCodes: [] }]);
    }
    if (has('wrong shop', 'lakeshore team')) return form('wrong_shop', []);
    if (has('whatever it needs', 'whatever you think')) return form('delegation', []);

    // Specific faults map to their specific catalog service (NOT to TUNE_BASIC by default).
    if (text.includes('brake') && has('pad', 'bleed')) {
      const wheels = text.includes('front') && !text.includes('rear') ? ['front'] : text.includes('rear') && !text.includes('front') ? ['rear'] : ['front', 'rear'];
      const codes: string[] = []; // map each specific brake service the customer named (both, if both)
      if (text.includes('pad')) codes.push('BRAKE_PADS');
      if (text.includes('bleed')) codes.push('BRAKE_BLEED');
      return form('repair', [{ bikeNumber: 1, issues: ['brake service'], serviceCodes: codes, wheels }]);
    }
    if (text.includes('brake')) {
      // A brake problem with no specific service named → one clarification (brake-related, never auto TUNE_BASIC).
      return unclearForm([{ bikeNumber: 1, issues: ['brakes'], serviceCodes: [] }], 'Which brake service would you like, and which wheel (front/rear)?');
    }
    // Explicit full/complete overhaul or rebuild → TUNE_FULL (overhaul intent, never just the word "service").
    if (has('overhaul', 'rebuild')) {
      return form('repair', [{ bikeNumber: 1, issues: ['full overhaul'], serviceCodes: ['TUNE_FULL'] }]);
    }
    // Diagnostic: inspect, or a symptom the customer can't localize → GENERAL_INSPECT (no fabricated repair).
    if (has('inspect', 'feels wrong', 'something wrong', 'not sure what') || (text.includes('noise') && has("can't locate", 'cannot locate', 'cant locate', 'can not locate', 'somewhere'))) {
      return form('repair', [{ bikeNumber: 1, issues: ['something feels wrong'], serviceCodes: ['GENERAL_INSPECT'] }]);
    }
    // Routine maintenance → TUNE_BASIC. A clear routine request is NOT ambiguous just because no fault is named.
    if (has('servic', 'maintenance', 'tune', 'tune-up', 'tuneup')) {
      return form('repair', [{ bikeNumber: 1, issues: ['routine maintenance'], serviceCodes: ['TUNE_BASIC'] }]);
    }
    return { kind: 'unclear', bikes: [], urgency: 'normal', dateWords: null, questionDraft: null };
  }
}

function unclearForm(bikes: Array<Record<string, unknown>>, questionDraft: string): unknown {
  return { kind: 'unclear', bikes, urgency: 'normal', dateWords: null, questionDraft };
}

function form(kind: string, bikes: Array<Record<string, unknown>>): unknown {
  return { kind, bikes, urgency: 'normal', dateWords: null, questionDraft: null };
}
