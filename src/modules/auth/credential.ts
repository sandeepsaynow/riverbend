import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credential token handling (D14). Format: `rb_<kind>_<prefix>.<secret>`.
 * We store only `prefix` (a public lookup handle) and the SHA-256 fingerprint of `secret` —
 * never the secret itself. Verification looks up by (kind, prefix) then constant-time compares.
 */
export type CredentialKind = 'shop' | 'admin';

// prefix is a lookup handle (lowercase hex / word chars); secret is the remainder after the first
// '.', accepting any non-space characters so an operator-supplied bootstrap secret is valid.
const TOKEN_RE = /^rb_(shop|admin)_([a-z0-9]+)\.(\S+)$/;

export interface ParsedToken {
  kind: CredentialKind;
  prefix: string;
  secret: string;
}

export function parseToken(token: string): ParsedToken | null {
  const m = TOKEN_RE.exec(token.trim());
  if (!m) return null;
  return { kind: m[1] as CredentialKind, prefix: m[2]!, secret: m[3]! };
}

export function fingerprint(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function secretsMatch(provided: string, storedFingerprint: Buffer): boolean {
  const candidate = fingerprint(provided);
  if (candidate.length !== storedFingerprint.length) return false;
  return timingSafeEqual(candidate, storedFingerprint);
}

export interface GeneratedCredential {
  token: string; // shown exactly once (FR-008)
  prefix: string;
  fingerprint: Buffer;
}

/** Generate a fresh credential of the given kind, returning the one-time token + what to store. */
export function generateCredential(kind: CredentialKind): GeneratedCredential {
  const prefix = randomBytes(5).toString('hex'); // 10 lowercase hex chars
  const secret = randomBytes(24).toString('hex'); // 48 hex chars (no '.' or space)
  return {
    token: `rb_${kind}_${prefix}.${secret}`,
    prefix,
    fingerprint: fingerprint(secret),
  };
}
