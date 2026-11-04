/**
 * Deterministic business-rule guards that sit between the model's (validated) extraction and the code
 * decision — code owns the outcome (Principle I). They fix real-eval product defects without trusting
 * the model to self-classify: broad delegation (m-1025), shop mismatch (m-1009), and bike over-count
 * (m-1032). All operate on the ORIGINAL customer message text, never on prices.
 */

// --- Broad delegation ("whatever it needs") → inspection, never an invented repair list (m-1025) ---

const DELEGATION_PATTERNS: RegExp[] = [
  /\bwhatever (?:it|you|she|he|they)(?:'| i)?s? (?:needs?|think|thinks|necessary|required|best)\b/i,
  /\bwhatever(?:'| i)?s (?:necessary|needed|required|best)\b/i,
  /\bwhatever needs (?:doing|to be done)\b/i,
  /\b(?:do|fix) (?:whatever|anything)\b/i,
  /\b(?:anything|everything) (?:that(?:'| i)?s )?(?:wrong|needed|it needs)\b/i,
];
// A directive negated right before it ("don't fix anything", "no need to do anything") is NOT delegation.
const NEGATED_DIRECTIVE = /\b(?:don'?t|do not|no need to|not)\b[^.?!]{0,20}\b(?:fix|do|touch|whatever|anything)\b/i;

export function hasBroadDelegation(content: string): boolean {
  if (NEGATED_DIRECTIVE.test(content)) {
    // Only treat as delegation if an affirmative phrase remains after removing the negated clause.
    const stripped = content.replace(NEGATED_DIRECTIVE, ' ');
    return DELEGATION_PATTERNS.some((re) => re.test(stripped));
  }
  return DELEGATION_PATTERNS.some((re) => re.test(content));
}

// --- Shop mismatch: message explicitly addresses a DIFFERENT Riverbend shop (m-1009) ---

/** A shop token is the slug minus the `rb-` prefix (e.g. "rb-lakeshore" → "lakeshore"). */
export function shopToken(slug: string): string {
  return slug.replace(/^rb-/i, '').trim().toLowerCase();
}

/**
 * True when the message addresses a shop OTHER than the authenticated tenant. Requires a shop-context
 * word (team/store/shop/…) or a greeting next to the other shop's name, so plain geography
 * ("I ride downtown", "Lakeshore Drive") does not trigger a false positive.
 */
export function detectShopMismatch(content: string, currentToken: string, allTokens: readonly string[]): boolean {
  const others = allTokens.map((t) => t.toLowerCase()).filter((t) => t && t !== currentToken.toLowerCase());
  for (const token of others) {
    const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const addressed = new RegExp(`\\b${t}\\b[^.?!]{0,15}\\b(?:team|store|shop|location|branch|crew|folks|staff)\\b`, 'i');
    const greeted = new RegExp(`\\b(?:hi|hello|hey|dear)\\b[^.?!]{0,12}\\b${t}\\b`, 'i');
    if (addressed.test(content) || greeted.test(content)) return true;
  }
  return false;
}

// --- Bike count: do not keep model-invented extra bicycles when the message signals only one (m-1032) ---

const MULTI_BIKE_PATTERNS: RegExp[] = [
  /\b(?:two|three|four|five|2|3|4|5|both|multiple|several)\b[^.?!]{0,15}\b(?:bikes?|bicycles?|cycles?)\b/i,
  /\b(?:bikes|bicycles|cycles)\b/i, // explicit plural
  /\b(?:and|&)\s+(?:mine|hers|his|theirs)\b/i,
  /\bmy\s+\w+(?:'s)?\s+(?:bike|bicycle)\s+and\s+(?:mine|my own)\b/i,
  /\b(?:our|both)\s+(?:bikes?|bicycles?)\b/i,
];

export function hasMultiBikeSignal(content: string): boolean {
  return MULTI_BIKE_PATTERNS.some((re) => re.test(content));
}
