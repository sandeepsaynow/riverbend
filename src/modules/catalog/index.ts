import type { Db } from '../../platform/db/index.js';
import { loadCatalogFile, type LoadedCatalog, type LoadedService } from './loader.js';

export type { LoadedService } from './loader.js';
export { CatalogError } from './loader.js';

export interface Catalog {
  catalog_version: string;
  services: LoadedService[];
}

export class CatalogService {
  private currentVersion: string | null = null;
  constructor(private readonly db: Db) {}

  /** Validate + upsert the committed catalog as versioned reference data (FR-016/018). */
  async seedFromFile(path: string): Promise<Catalog> {
    const loaded: LoadedCatalog = loadCatalogFile(path);
    for (const s of loaded.services) {
      await this.db.adminQuery(
        `INSERT INTO catalog_service (catalog_version, code, name, price_cents, minutes, requires_inspection)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (catalog_version, code)
         DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
                       minutes = EXCLUDED.minutes, requires_inspection = EXCLUDED.requires_inspection`,
        [loaded.catalog_version, s.code, s.name, s.price_cents, s.minutes, s.requires_inspection],
      );
    }
    this.currentVersion = loaded.catalog_version;
    return { catalog_version: loaded.catalog_version, services: loaded.services };
  }

  /** The current catalog version + its 12 services, readable by any authenticated shop. */
  async getCatalog(): Promise<Catalog> {
    const version =
      this.currentVersion ??
      (
        await this.db.appQuery<{ catalog_version: string }>(
          `SELECT catalog_version FROM catalog_service ORDER BY catalog_version DESC LIMIT 1`,
        )
      ).rows[0]?.catalog_version ??
      null;
    if (!version) return { catalog_version: 'cat-000', services: [] };

    const res = await this.db.appQuery<LoadedService>(
      `SELECT code, name, price_cents, minutes, requires_inspection
         FROM catalog_service WHERE catalog_version = $1 ORDER BY code`,
      [version],
    );
    return { catalog_version: version, services: res.rows };
  }
}
