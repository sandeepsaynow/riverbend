import pg from 'pg';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;

export interface DbUrls {
  appUrl: string;
  adminUrl: string;
}

/**
 * Database access with two runtime roles (D2, Principle III):
 *  - app (role `app_user`, NOBYPASSRLS): shop-scoped request handling. Forced RLS restricts it to
 *    `current_setting('app.tenant_id')`. This is the role the I1 attack test connects as.
 *  - admin (role `app_admin`, NOBYPASSRLS): the admin/auth module ONLY — the documented cross-shop
 *    exception (credential lookup, provisioning). Never used on shop-scoped routes.
 */
export class Db {
  readonly appPool: pg.Pool;
  readonly adminPool: pg.Pool;

  constructor(urls: DbUrls) {
    this.appPool = new Pool({ connectionString: urls.appUrl });
    this.adminPool = new Pool({ connectionString: urls.adminUrl });
  }

  /**
   * Run `fn` as app_user inside a transaction bound to one shop. The tenant id is set
   * transaction-locally; RLS does the rest. A forgotten WHERE clause cannot leak another shop.
   */
  async withTenant<T>(shopId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.appPool.connect();
    try {
      await client.query('BEGIN');
      // set_config(..., true) => transaction-local; parameterized to avoid injection.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [shopId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Run a query as app_user with NO tenant set (sees nothing under RLS unless intentional). */
  async appQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.appPool.query<R>(text, params as never[]);
  }

  /** Run a query as app_admin (cross-shop by design; admin/auth module only). */
  async adminQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.adminPool.query<R>(text, params as never[]);
  }

  async close(): Promise<void> {
    await Promise.all([this.appPool.end(), this.adminPool.end()]);
  }
}
