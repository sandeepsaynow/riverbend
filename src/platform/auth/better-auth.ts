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

/**
 * The exact set of trusted origins (scheme://host:port) for CSRF/Origin validation (D20.2). Production is a
 * strict single-origin HTTPS allowlist (just BETTER_AUTH_URL). In non-production we ALSO allow the sibling
 * loopback host at the same scheme+port (localhost ⇄ 127.0.0.1) so a local browser works from either, without
 * weakening validation — every entry is a full, exact origin. Used by both Better Auth and the portal guard.
 */
export function trustedOriginsFor(baseUrl: string, isProduction: boolean): string[] {
  const out = new Set<string>();
  try {
    const u = new URL(baseUrl);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    out.add(`${u.protocol}//${u.hostname}:${port}`);
    if (!isProduction) {
      const sibling = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname === '127.0.0.1' ? 'localhost' : null;
      if (sibling) out.add(`${u.protocol}//${sibling}:${port}`);
    }
  } catch {
    /* invalid base URL → empty allowlist (fail closed) */
  }
  return [...out];
}

/** Normalize an Origin/Referer header to scheme://host:port for exact comparison; null if unparseable. */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${u.hostname}:${port}`;
  } catch {
    return null;
  }
}
