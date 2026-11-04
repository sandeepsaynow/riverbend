import type { Db } from '../../platform/db/index.js';

/** The admin operations the provisioner needs — lets tests inject a fake without a live proxy. */
export interface LiteLlmAdminApi {
  createTeam(alias: string, budgetUsd: number, budgetDuration: string): Promise<string>;
  createVirtualKey(teamId: string, alias: string): Promise<string>;
}

/**
 * LiteLLM admin API client (constitution 2.0.0). Uses the MASTER key — provisioning/admin path ONLY,
 * never ordinary inference. Creates one team per shop with a monthly budget and a restricted virtual
 * key. Errors are message-only (no secrets, VII).
 */
export class LiteLlmAdmin implements LiteLlmAdminApi {
  constructor(private readonly cfg: { baseUrl: string; masterKey: string }) {}

  private base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.masterKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`LiteLLM admin request to ${path} failed (network/timeout)`);
    }
    if (!res.ok) throw new Error(`LiteLLM admin ${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Create a team with a monthly budget (USD). budgetDuration e.g. "30d". Returns the team id. */
  async createTeam(alias: string, budgetUsd: number, budgetDuration: string): Promise<string> {
    const r = await this.post<{ team_id: string }>('/team/new', {
      team_alias: alias,
      max_budget: budgetUsd,
      budget_duration: budgetDuration,
    });
    return r.team_id;
  }

  /** Create a restricted virtual key bound to a team. Returns the key secret. */
  async createVirtualKey(teamId: string, alias: string): Promise<string> {
    const r = await this.post<{ key: string }>('/key/generate', { team_id: teamId, key_alias: alias });
    return r.key;
  }
}

/**
 * Ensures a shop has a LiteLLM identity (team + virtual key), persisted in shop_llm_identity and
 * resolved server-side by the authenticated tenant. Lazy + idempotent: provisions on first use, then
 * reuses the stored key. The master key never leaves the provisioner.
 */
export class LiteLlmProvisioner {
  constructor(
    private readonly db: Db,
    private readonly admin: LiteLlmAdminApi,
    private readonly opts: { budgetUsd: number; budgetDuration: string },
  ) {}

  async ensureVirtualKey(shopId: string): Promise<string> {
    const existing = await this.db.withTenant(shopId, (c) =>
      c.query<{ virtual_key: string }>(`SELECT virtual_key FROM shop_llm_identity WHERE shop_id = $1`, [shopId]),
    );
    if (existing.rows[0]) return existing.rows[0].virtual_key;

    const teamId = await this.admin.createTeam(`shop:${shopId}`, this.opts.budgetUsd, this.opts.budgetDuration);
    const key = await this.admin.createVirtualKey(teamId, `shop:${shopId}:worker`);
    // ON CONFLICT handles a race where two workers provision the same shop concurrently.
    const stored = await this.db.withTenant(shopId, (c) =>
      c.query<{ virtual_key: string }>(
        `INSERT INTO shop_llm_identity (shop_id, team_id, virtual_key) VALUES ($1, $2, $3)
         ON CONFLICT (shop_id) DO NOTHING RETURNING virtual_key`,
        [shopId, teamId, key],
      ),
    );
    if (stored.rows[0]) return stored.rows[0].virtual_key;
    // Lost the race → read the winner's key.
    const winner = await this.db.withTenant(shopId, (c) =>
      c.query<{ virtual_key: string }>(`SELECT virtual_key FROM shop_llm_identity WHERE shop_id = $1`, [shopId]),
    );
    return winner.rows[0]!.virtual_key;
  }
}
