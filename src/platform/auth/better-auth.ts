import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import type { Pool } from 'pg';

/**
 * Better Auth (D20, Feature 010) — the authority for human email/password authentication, password
 * hashing, and sessions. Public signup is DISABLED (admin-created accounts only); the `admin()` plugin
 * adds server-side user management (createUser/ban/revokeSessions). Riverbend owns authorization
 * (shop_membership → forced RLS). Better Auth's own tables are global (its Pool), never under tenant RLS.
 */
export interface AuthDeps {
  pool: Pool; // dedicated connection for Better Auth's global identity tables (owner/migrator role)
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  secureCookies: boolean;
}

// Inlined (not annotated as BetterAuthOptions) so TypeScript infers the admin() plugin's api methods
// (createUser/banUser/listUsers/…) onto the returned type.
export function createAuth(deps: AuthDeps) {
  return betterAuth({
    database: deps.pool,
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    trustedOrigins: deps.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // no public signup — admin creates accounts
      minPasswordLength: 12, // strong-ish for a no-MFA system
    },
    plugins: [admin()],
    advanced: { useSecureCookies: deps.secureCookies },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export { toNodeHandler, fromNodeHeaders };
