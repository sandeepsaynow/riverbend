import type { Request } from './typed-route.js';
import { HttpError } from './typed-route.js';

/**
 * The authenticated principal, attached by the auth middleware. The shop identity used for all
 * tenant-scoped work comes ONLY from here (FR-001) — never from the request body or path.
 */
export interface AuthContext {
  credentialId: string;
  kind: 'shop' | 'admin';
  shopId: string | null; // the shop for kind='shop'; null for kind='admin'
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function getAuth(req: Request): AuthContext | undefined {
  return req.auth;
}

/** The authenticated shop id, taken strictly from the credential. Throws if not a shop principal. */
export function requireShopId(req: Request): string {
  const auth = req.auth;
  if (!auth || auth.kind !== 'shop' || !auth.shopId) {
    throw new HttpError(403, 'forbidden', 'A shop credential is required for this route');
  }
  return auth.shopId;
}
