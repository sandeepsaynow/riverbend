import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mintReplyToken, readReplyToken } from '../../src/modules/email/tokens.js';

const KEY = 'reply-token-unit-key';
const DOMAIN = 'karoiechou.resend.app'; // a realistic Resend-managed receiving domain

describe('006/D21.2 — reply-correlation token invariants', () => {
  it('the full reply+<token>@<domain> local part stays <= 64 octets for all UUIDs (RFC 5321)', () => {
    for (let i = 0; i < 2000; i++) {
      const token = mintReplyToken(KEY, randomUUID(), randomUUID());
      const localPart = `reply+${token}`;
      expect(Buffer.byteLength(localPart, 'ascii')).toBeLessThanOrEqual(64);
      expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true); // base64url only → valid in an address local part
    }
  });

  it('round-trips the exact (shopId, requestId) pair', () => {
    const shop = randomUUID();
    const req = randomUUID();
    const back = readReplyToken(KEY, mintReplyToken(KEY, shop, req));
    expect(back).toEqual({ shopId: shop, requestId: req });
  });

  it('rejects a tampered token (any flipped char) and a wrong key', () => {
    const token = mintReplyToken(KEY, randomUUID(), randomUUID());
    // flip one character in the middle
    const i = Math.floor(token.length / 2);
    const flipped = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
    expect(readReplyToken(KEY, flipped)).toBeNull();
    expect(readReplyToken('other-key', token)).toBeNull(); // forged under a different signing key
    expect(readReplyToken(KEY, 'not.a.valid.token')).toBeNull();
    expect(readReplyToken(KEY, '')).toBeNull();
  });

  it('a token minted for one (shop, request) never decodes to another pair (no cross-tenant correlation)', () => {
    const a = mintReplyToken(KEY, randomUUID(), randomUUID());
    const b = mintReplyToken(KEY, randomUUID(), randomUUID());
    expect(a).not.toBe(b);
    expect(readReplyToken(KEY, a)).not.toEqual(readReplyToken(KEY, b));
  });
});
