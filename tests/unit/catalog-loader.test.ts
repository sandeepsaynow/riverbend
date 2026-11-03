import { describe, it, expect } from 'vitest';
import { parseCatalog, CatalogError } from '../../src/modules/catalog/loader.js';

function svc(code: string, price: number) {
  return { code, name: code, price, minutes: 30, requires_inspection: false };
}
function twelve(prices?: number[]): unknown {
  const services = Array.from({ length: 12 }, (_, i) => svc(`S${i}`, prices?.[i] ?? 10));
  return { catalog_version: 'cat-001', currency: 'USD', services };
}

describe('catalog loader (FR-016/017/018, I5)', () => {
  it('accepts exactly 12 services and converts USD dollars to whole cents', () => {
    const c = parseCatalog({
      catalog_version: 'cat-001',
      currency: 'USD',
      services: Array.from({ length: 12 }, (_, i) => svc(`S${i}`, 65)),
    });
    expect(c.catalog_version).toBe('cat-001');
    expect(c.services).toHaveLength(12);
    expect(c.services[0]!.price_cents).toBe(6500);
  });

  it('rejects a non-whole-cent price (I5)', () => {
    const prices = Array(12).fill(10);
    prices[3] = 45.005;
    expect(() => parseCatalog(twelve(prices))).toThrowError(CatalogError);
  });

  it('rejects a duplicate service code within a version (FR-016)', () => {
    const data = twelve() as { services: Array<{ code: string }> };
    data.services[1]!.code = data.services[0]!.code;
    expect(() => parseCatalog(data)).toThrowError(CatalogError);
  });

  it('rejects a catalog that does not have exactly 12 services', () => {
    expect(() =>
      parseCatalog({
        catalog_version: 'cat-001',
        currency: 'USD',
        services: [svc('ONLY', 10)],
      }),
    ).toThrowError(CatalogError);
  });

  it('rejects a malformed catalog version id', () => {
    expect(() => parseCatalog({ ...(twelve() as object), catalog_version: 'v1' })).toThrowError(
      CatalogError,
    );
  });
});
