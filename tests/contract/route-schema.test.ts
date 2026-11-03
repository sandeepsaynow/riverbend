import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { registeredRoutes } from '../../src/platform/http/typed-route.js';
import { createLogger } from '../../src/platform/observability/logger.js';
import { AuthService } from '../../src/modules/auth/index.js';
import { ShopsService } from '../../src/modules/shops/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { IntakeService } from '../../src/modules/intake/index.js';
import { OrdersService } from '../../src/modules/orders/index.js';
import type { Db } from '../../src/platform/db/index.js';
import type { Config } from '../../src/platform/config/index.js';

// Building the app registers every route via defineRoute without touching the database (handlers
// are not invoked). We then assert every declared route carries schemas (D12, tasks T054).
describe('route-schema contract (D12)', () => {
  it('every mounted route declares a response schema', () => {
    const fakeDb = {} as unknown as Db;
    const config = {
      DATABASE_ADMIN_URL: 'x',
      DATABASE_URL: 'x',
      DATABASE_MIGRATOR_URL: 'x',
      ADMIN_BOOTSTRAP_TOKEN: 'x',
      PORT: 8080,
      LOG_LEVEL: 'fatal',
      NODE_ENV: 'test',
    } as unknown as Config;

    createApp({
      config,
      db: fakeDb,
      logger: createLogger('fatal'),
      auth: new AuthService(fakeDb),
      shops: new ShopsService(fakeDb),
      catalog: new CatalogService(fakeDb),
      intake: new IntakeService(fakeDb),
      orders: new OrdersService(fakeDb),
    });

    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const r of routes) {
      expect(r.hasResponse, `${r.method} ${r.path} must declare a response schema`).toBe(true);
    }
    // Routes with path params declare a params schema.
    for (const r of routes.filter((x) => x.path.includes(':'))) {
      expect(r.hasParams, `${r.method} ${r.path} must declare a params schema`).toBe(true);
    }
  });
});
