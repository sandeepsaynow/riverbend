import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reply-correlation token (D10/D21): a signed `reply+<token>@domain` address binds an inbound reply to
 * one (shop, request) without trusting the sender. Keyed by EMAIL_SIGNING_KEY.
 *
 * Encoding (D21.2 fix): the two UUIDs are packed as **raw bytes** (16 + 16) plus a truncated HMAC, then
 * base64url'd as a single blob — 42 bytes → 56 chars, so the full `reply+<token>@` local part is 62
 * chars, within RFC 5321's 64-char limit. (The earlier string encoding produced a ~142-char local part,
 * which strict providers like Resend reject with HTTP 422.) The 80-bit truncated HMAC remains unforgeable
 * and is backed by the one-round + `awaiting_customer` + Message-ID de-dup gates downstream.
 */
const MAC_LEN = 10; // bytes (80-bit) truncated HMAC — keeps the address within the 64-char local-part limit

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || /[^0-9a-f]/i.test(hex)) throw new Error('not a uuid');
  return Buffer.from(hex, 'hex');
}
function bytesToUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function mintReplyToken(key: string, shopId: string, requestId: string): string {
  const payload = Buffer.concat([uuidToBytes(shopId), uuidToBytes(requestId)]); // 32 bytes
  const mac = createHmac('sha256', key).update(payload).digest().subarray(0, MAC_LEN);
  return Buffer.concat([payload, mac]).toString('base64url'); // 42 bytes → 56 base64url chars
}

export function readReplyToken(key: string, token: string): { shopId: string; requestId: string } | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (raw.length !== 32 + MAC_LEN) return null; // 32-byte payload + truncated MAC
  const payload = raw.subarray(0, 32);
  const mac = raw.subarray(32);
  const expected = createHmac('sha256', key).update(payload).digest().subarray(0, MAC_LEN);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    return { shopId: bytesToUuid(payload.subarray(0, 16)), requestId: bytesToUuid(payload.subarray(16, 32)) };
  } catch {
    return null;
  }
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
