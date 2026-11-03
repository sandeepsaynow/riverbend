import { describe, it, expect } from 'vitest';
import { FakeGateway } from '../../src/platform/llm/fake-gateway.js';
import { validateExtraction, ExtractionInvalid } from '../../src/modules/pipeline/schema.js';

const CATALOG = new Set([
  'TUNE_BASIC', 'TUNE_FULL', 'BRAKE_ADJUST', 'BRAKE_PADS', 'BRAKE_BLEED', 'GEAR_ADJUST',
  'CHAIN_REPLACE', 'FLAT_FIX', 'TIRE_REPLACE', 'WHEEL_TRUE', 'EBIKE_DIAG', 'GENERAL_INSPECT',
]);
const gw = new FakeGateway();

describe('extraction validation (I3) — invalid output is never accepted', () => {
  it('accepts a schema-valid form with known catalog codes', async () => {
    const raw = await gw.extract({ content: 'my bike needs a tune' });
    const ex = validateExtraction(raw, CATALOG);
    expect(ex.kind).toBe('repair');
    expect(ex.bikes[0]!.serviceCodes).toContain('TUNE_BASIC');
  });

  it('rejects malformed (non-schema) model output', async () => {
    const raw = await gw.extract({ content: '__BAD_JSON__' });
    expect(() => validateExtraction(raw, CATALOG)).toThrow(ExtractionInvalid);
  });

  it('rejects an unknown service code not in the catalog', async () => {
    const raw = await gw.extract({ content: '__BAD_CODE__' });
    expect(() => validateExtraction(raw, CATALOG)).toThrow(ExtractionInvalid);
  });

  it('classifies price inquiry / wrong shop / delegation without inventing codes', async () => {
    expect(validateExtraction(await gw.extract({ content: 'how much for an overhaul?' }), CATALOG).kind).toBe('price_inquiry');
    expect(validateExtraction(await gw.extract({ content: 'Hi Lakeshore team!' }), CATALOG).kind).toBe('wrong_shop');
    expect(validateExtraction(await gw.extract({ content: 'just do whatever it needs' }), CATALOG).kind).toBe('delegation');
  });
});
