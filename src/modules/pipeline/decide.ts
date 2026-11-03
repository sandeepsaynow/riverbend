import type { Extraction } from './schema.js';

/**
 * Catalog services priced "per wheel" — these require the wheel(s) to be named, else code asks the
 * one clarification. (From the brief's catalog names containing "(per wheel)".)
 */
export const PER_WHEEL = new Set([
  'BRAKE_ADJUST', 'BRAKE_PADS', 'BRAKE_BLEED', 'FLAT_FIX', 'TIRE_REPLACE', 'WHEEL_TRUE',
]);

export type Decision =
  | { outcome: 'extracted'; flagged: boolean } // ready for a work order (slice 004); flagged = general inspection
  | { outcome: 'answered' } // price inquiry, no order
  | { outcome: 'needs_review'; reason: string }
  | { outcome: 'ask'; question: string }; // ask the single follow-up → awaiting_customer

const FALLBACK_QUESTION = 'Could you tell us which service your bike needs (and which wheel, if relevant)?';

/** Code gates the model's drafted wording: length-capped, no links, no prices; else a fixed template. */
export function gateQuestion(draft: string | null | undefined): string {
  if (draft && draft.trim().length > 0 && draft.length <= 200 && !/https?:\/\//i.test(draft) && !/[$€£]\s?\d/.test(draft)) {
    return draft.trim();
  }
  return FALLBACK_QUESTION;
}

/**
 * Deterministic decision from the VALIDATED form (I6 one-question policy, D5). The model never decides;
 * this does. `alreadyAsked` is true when the single follow-up has already been asked (i.e. this is the
 * resume after the customer's one reply).
 */
export function decide(ex: Extraction, alreadyAsked: boolean): Decision {
  if (ex.kind === 'wrong_shop') return { outcome: 'needs_review', reason: 'wrong_shop_suspected' };
  if (ex.kind === 'price_inquiry') return { outcome: 'answered' };
  if (ex.kind === 'delegation') return { outcome: 'extracted', flagged: true }; // flagged general inspection

  // repair / unclear: "required" = ≥1 catalog service, and per-wheel services need wheels named.
  const hasService = ex.bikes.some((b) => b.serviceCodes.length > 0);
  const perWheelOk = ex.bikes.every((b) =>
    b.serviceCodes.every((c) => !PER_WHEEL.has(c) || (b.wheels !== undefined && b.wheels.length > 0)),
  );
  if (hasService && perWheelOk) return { outcome: 'extracted', flagged: false };

  if (!alreadyAsked) return { outcome: 'ask', question: gateQuestion(ex.questionDraft) };

  // The one reply still did not resolve it: symptom present → general inspection; else needs_review.
  const hasSymptom = ex.bikes.some((b) => b.issues.length > 0);
  return hasSymptom
    ? { outcome: 'extracted', flagged: true }
    : { outcome: 'needs_review', reason: 'unresolved_after_one_question' };
}
