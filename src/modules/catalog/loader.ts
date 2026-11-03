import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Load and validate the authoritative catalog JSON (FR-016/017/018). Prices in the file are USD
 * dollars; they are converted to whole integer cents and any non-whole-cent price is rejected (I5).
 * Exactly 12 services; `code` unique within the version; version id is deterministic `cat-NNN`.
 */
export class CatalogError extends Error {}

const ServiceInput = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  price: z.number().nonnegative(),
  minutes: z.number().int().nonnegative(),
  requires_inspection: z.boolean(),
});

const CatalogFile = z
  .object({
    catalog_version: z.string().regex(/^cat-\d{3}$/, 'catalog_version must look like cat-001'),
    currency: z.string().min(1),
    services: z.array(ServiceInput).length(12, 'exactly 12 services are required'),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const s of file.services) {
      if (seen.has(s.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate service code: ${s.code}` });
      }
      seen.add(s.code);
    }
  });

export interface LoadedService {
  code: string;
  name: string;
  price_cents: number;
  minutes: number;
  requires_inspection: boolean;
}
export interface LoadedCatalog {
  catalog_version: string;
  services: LoadedService[];
}

function toWholeCents(price: number, code: string): number {
  const scaled = price * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 1e-6) {
    throw new CatalogError(`Service ${code} price ${price} is not a whole number of cents`);
  }
  return cents;
}

export function parseCatalog(raw: unknown): LoadedCatalog {
  const result = CatalogFile.safeParse(raw);
  if (!result.success) {
    throw new CatalogError(
      `Invalid catalog: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const file = result.data;
  return {
    catalog_version: file.catalog_version,
    services: file.services.map((s) => ({
      code: s.code,
      name: s.name,
      price_cents: toWholeCents(s.price, s.code),
      minutes: s.minutes,
      requires_inspection: s.requires_inspection,
    })),
  };
}

export function loadCatalogFile(path: string): LoadedCatalog {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CatalogError(`Catalog file not found: ${path}`);
  }
  return parseCatalog(JSON.parse(text));
}
