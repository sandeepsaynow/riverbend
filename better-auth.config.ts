// CLI-only config for `@better-auth/cli generate` (schema generation). Not imported by the app.
import { Pool } from 'pg';
import { createAuth } from './src/platform/auth/better-auth.js';

export const auth = createAuth({
  pool: new Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://u:p@localhost:5432/riverbend' }),
  secret: 'cli-generation-only',
  baseURL: 'http://localhost:8080',
  trustedOrigins: ['http://localhost:8080'],
  secureCookies: false,
});
