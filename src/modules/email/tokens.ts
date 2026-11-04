import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reply-correlation token (D10): a signed `reply+<token>@domain` address binds an inbound reply to one
 * (shop, request) without trusting the sender. Keyed by EMAIL_SIGNING_KEY. Also used to verify the
 * inbound webhook signature (HMAC over the raw body).
 */
function sign(key: string, payload: string): string {
  const mac = createHmac('sha256', key).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

export function mintReplyToken(key: string, shopId: string, requestId: string): string {
  return sign(key, `${shopId}:${requestId}`);
}

export function readReplyToken(key: string, token: string): { shopId: string; requestId: string } | null {
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
  const [shopId, requestId] = payload.split(':');
  return shopId && requestId ? { shopId, requestId } : null;
}

/** Verify an inbound-webhook HMAC signature (hex) over the raw body. Constant-time. */
export function verifyWebhookSignature(secret: string, rawBody: string, signatureHex: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
