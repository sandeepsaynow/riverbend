import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { FakeGateway } from '../../src/platform/llm/fake-gateway.js';
import { validateExtraction } from '../../src/modules/pipeline/schema.js';
import { decide, type Decision } from '../../src/modules/pipeline/decide.js';

const catalog = JSON.parse(readFileSync(new URL('../../catalog/catalog.json', import.meta.url), 'utf8')) as {
  services: Array<{ code: string; price: number }>;
};
const CATALOG = new Set(catalog.services.map((s) => s.code));
const priceCents = (code: string): number => Math.round(catalog.services.find((s) => s.code === code)!.price * 100);
const gw = new FakeGateway();

/** Run a message through the deterministic pipeline (extract → validate → decide), as the worker does. */
async function classify(content: string, alreadyAsked = false): Promise<{ codes: string[]; kind: string; decision: Decision }> {
  const ex = validateExtraction(await gw.extract({ content }), CATALOG);
  return { codes: ex.bikes.flatMap((b) => b.serviceCodes), kind: ex.kind, decision: decide(ex, alreadyAsked) };
}

describe('003/D5 — catalog servicing classification (general-servicing regression)', () => {
  it('REGRESSION — "general servicing" → TUNE_BASIC, ordered, NO clarification', async () => {
    const r = await classify('My bike needs general servicing.');
    expect(r.codes).toEqual(['TUNE_BASIC']);
    expect(r.decision).toEqual({ outcome: 'extracted', flagged: false }); // not "ask" → no clarification email
  });

  it('routine maintenance phrasings all map to TUNE_BASIC and are extracted (no clarification)', async () => {
    for (const msg of ['I want a regular tune-up', 'Routine bike maintenance please', 'Please give my bicycle a basic service']) {
      const r = await classify(msg);
      expect(r.codes, msg).toEqual(['TUNE_BASIC']);
      expect(r.decision.outcome, msg).toBe('extracted');
    }
  });

  it('explicit full overhaul → TUNE_FULL (never chosen for the mere word "service")', async () => {
    expect((await classify('I need a complete overhaul')).codes).toEqual(['TUNE_FULL']);
    expect((await classify('Please give my bicycle a basic service')).codes).not.toContain('TUNE_FULL');
  });

  it('diagnostic / unlocalized symptom → GENERAL_INSPECT, extracted', async () => {
    expect((await classify('I want my bike inspected because something feels wrong')).codes).toEqual(['GENERAL_INSPECT']);
    expect((await classify('My bike makes a strange noise but I cannot locate it')).codes).toEqual(['GENERAL_INSPECT']);
  });

  it('price-only inquiry → answered, no work order', async () => {
    const r = await classify('How much is servicing?');
    expect(r.kind).toBe('price_inquiry');
    expect(r.decision).toEqual({ outcome: 'answered' });
  });

  it('cancellation → no fabricated service and no order (a person follows up)', async () => {
    const r = await classify('Cancel my previous repair');
    expect(r.codes).toEqual([]); // no TUNE_BASIC fabricated
    expect(r.decision.outcome).toBe('ask'); // routed to a human-style follow-up, NOT "extracted" (no order), never auto-cancel
  });

  it('a non-specific brake problem is NOT auto TUNE_BASIC — it asks (brake-related)', async () => {
    const r = await classify('My brakes are not working');
    expect(r.codes).not.toContain('TUNE_BASIC');
    expect(r.decision.outcome).toBe('ask');
  });

  it('a specific brake fault maps to the specific catalog service', async () => {
    const r = await classify('Please replace the front brake pads');
    expect(r.codes).toEqual(['BRAKE_PADS']);
    expect(r.decision.outcome).toBe('extracted'); // front wheel named → per-wheel satisfied
  });

  it('truly ambiguous message → exactly one clarification', async () => {
    const r = await classify('hello there');
    expect(r.decision.outcome).toBe('ask');
  });

  it('multiple bikes each with a service → extracted per bike (decision level)', () => {
    const multi = decide({ kind: 'repair', urgency: 'normal', dateWords: null, bikes: [
      { bikeNumber: 1, issues: ['tune'], serviceCodes: ['TUNE_BASIC'] },
      { bikeNumber: 2, issues: ['chain'], serviceCodes: ['CHAIN_REPLACE'] },
    ] }, false);
    expect(multi).toEqual({ outcome: 'extracted', flagged: false });
  });

  it('TUNE_BASIC is priced from the catalog at $65 (code never invents a price)', () => {
    expect(priceCents('TUNE_BASIC')).toBe(6500);
  });
});
