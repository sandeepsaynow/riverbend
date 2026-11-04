import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, stateless tokens for the public web form (D11, Constitution III): the shop id is carried in
 * an HMAC-signed token minted server-side, never trusted from the client. A form token binds a submit
 * to a shop; a status token binds a status page to one request. Keyed by WEB_FORM_SIGNING_KEY.
 */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(key: string, payload: string): string {
  const mac = createHmac('sha256', key).update(payload).digest();
  return `${b64url(Buffer.from(payload))}.${b64url(mac)}`;
}

function verify(key: string, token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let payload: string;
  let mac: Buffer;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    mac = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', key).update(payload).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return payload;
}

const FORM_PREFIX = 'f:';
const STATUS_PREFIX = 's:';

export function mintFormToken(key: string, shopId: string): string {
  return sign(key, `${FORM_PREFIX}${shopId}`);
}
export function readFormToken(key: string, token: string): string | null {
  const p = verify(key, token);
  return p && p.startsWith(FORM_PREFIX) ? p.slice(FORM_PREFIX.length) : null;
}

export function mintStatusToken(key: string, shopId: string, requestId: string): string {
  return sign(key, `${STATUS_PREFIX}${shopId}:${requestId}`);
}
export function readStatusToken(key: string, token: string): { shopId: string; requestId: string } | null {
  const p = verify(key, token);
  if (!p || !p.startsWith(STATUS_PREFIX)) return null;
  const [shopId, requestId] = p.slice(STATUS_PREFIX.length).split(':');
  return shopId && requestId ? { shopId, requestId } : null;
}
