import type { NextFunction, Request, Response } from '../../platform/http/typed-route.js';
import type { AuthService } from './index.js';

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}

/**
 * Require an authenticated principal of the given kind (FR-023). Sets req.auth.
 *  - no/invalid/revoked credential        -> 401
 *  - valid credential of the wrong kind   -> 403 (shop key on admin route, or vice-versa; FR-020)
 */
function requireKind(auth: AuthService, kind: 'shop' | 'admin') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: 'unauthorized', message: 'Missing bearer credential' });
      return;
    }
    const principal = await auth.authenticate(token);
    if (!principal) {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid or revoked credential' });
      return;
    }
    if (principal.kind !== kind) {
      res.status(403).json({
        error: 'forbidden',
        message: `This route requires a ${kind} credential`,
      });
      return;
    }
    req.auth = principal;
    next();
  };
}

export const adminAuth = (auth: AuthService) => requireKind(auth, 'admin');
export const shopAuth = (auth: AuthService) => requireKind(auth, 'shop');
