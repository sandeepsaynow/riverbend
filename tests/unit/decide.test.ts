import { describe, it, expect } from 'vitest';
import { decide } from '../../src/modules/pipeline/decide.js';
import type { Extraction } from '../../src/modules/pipeline/schema.js';

function ex(partial: Partial<Extraction>): Extraction {
  return { kind: 'repair', bikes: [], urgency: 'normal', dateWords: null, ...partial } as Extraction;
}

describe('decision logic (D5, I6) — code decides, not the model', () => {
  it('D32: wrong_shop is NOT a routing signal — treated as a normal message for the origin shop', () => {
    // no service named → ask for repair details (never needs_review, never a tenant move)
    expect(decide(ex({ kind: 'wrong_shop' }), false).outcome).toBe('ask');
    // a service named → extract an order for the ORIGIN shop regardless of the shop mention
    expect(decide(ex({ kind: 'wrong_shop', bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }] }), false))
      .toEqual({ outcome: 'extracted', flagged: false });
  });
  it('price inquiry → answered, no order', () => {
    expect(decide(ex({ kind: 'price_inquiry' }), false)).toEqual({ outcome: 'answered' });
  });
  it('delegation → flagged general inspection', () => {
    expect(decide(ex({ kind: 'delegation' }), false)).toEqual({ outcome: 'extracted', flagged: true });
  });
  it('repair with a known service → extracted (not flagged)', () => {
    expect(decide(ex({ bikes: [{ bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] }] }), false)).toEqual({ outcome: 'extracted', flagged: false });
  });
  it('per-wheel service without a wheel named → ask one question', () => {
    const d = decide(ex({ bikes: [{ bikeNumber: 1, issues: ['brake'], serviceCodes: ['BRAKE_PADS'] }] }), false);
    expect(d.outcome).toBe('ask');
  });
  it('ambiguous, not yet asked → ask; the model draft is gated', () => {
    expect(decide(ex({ kind: 'unclear', bikes: [], questionDraft: 'Which service?' }), false)).toEqual({ outcome: 'ask', question: 'Which service?' });
    const withPrice = decide(ex({ kind: 'unclear', questionDraft: 'Pay $50 here http://x' }), false);
    expect(withPrice.outcome).toBe('ask');
    if (withPrice.outcome === 'ask') expect(withPrice.question).not.toContain('$50'); // gated → fallback template
  });
  it('after the one reply: symptom → general inspection; no symptom → needs_review', () => {
    expect(decide(ex({ kind: 'unclear', bikes: [{ bikeNumber: 1, issues: ['brakes'], serviceCodes: [] }] }), true)).toEqual({ outcome: 'extracted', flagged: true });
    expect(decide(ex({ kind: 'unclear', bikes: [] }), true)).toEqual({ outcome: 'needs_review', reason: 'unresolved_after_one_question' });
  });
});
