import { createHash } from 'node:crypto';

/**
 * Canonicalize message content for conflict detection (research R2): Unicode NFC, trim, and collapse
 * internal whitespace runs to a single space. The content fingerprint is SHA-256 of this canonical
 * form, so a trivial whitespace/encoding difference does not produce a false 409, while a genuine
 * wording change does. The fingerprint is used ONLY for same-identifier conflict detection — never to
 * key or merge deduplication (FR-015).
 */
export function canonicalizeContent(content: string): string {
  return content.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function contentFingerprint(content: string): Buffer {
  return createHash('sha256').update(canonicalizeContent(content), 'utf8').digest();
}
