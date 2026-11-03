import { z } from 'zod';

/**
 * The strict extraction form the model fills. Code validates raw model output against this (I3);
 * anything failing — bad shape, or a service code not in the catalog — is rejected and never persisted
 * as a work order. The model proposes structure only; it never supplies prices or chooses identity.
 */
export const ExtractionSchema = z.object({
  kind: z.enum(['repair', 'price_inquiry', 'wrong_shop', 'delegation', 'unclear']),
  bikes: z.array(
    z.object({
      bikeNumber: z.number().int().positive(),
      issues: z.array(z.string()).default([]),
      serviceCodes: z.array(z.string()),
      wheels: z.array(z.enum(['front', 'rear'])).optional(),
    }),
  ),
  urgency: z.enum(['normal', 'urgent']),
  dateWords: z.string().nullable(),
  questionDraft: z.string().nullable().optional(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export class ExtractionInvalid extends Error {}

/**
 * Validate raw model output (I3): structural schema + every service code must exist in the catalog.
 * Throws ExtractionInvalid on any violation — the caller must NOT persist a work order from it.
 */
export function validateExtraction(raw: unknown, validCatalogCodes: ReadonlySet<string>): Extraction {
  const parsed = ExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExtractionInvalid(`schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  for (const bike of parsed.data.bikes) {
    for (const code of bike.serviceCodes) {
      if (!validCatalogCodes.has(code)) {
        throw new ExtractionInvalid(`unknown service code: ${code}`);
      }
    }
  }
  return parsed.data;
}
