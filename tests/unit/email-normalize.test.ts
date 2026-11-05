import { describe, it, expect } from 'vitest';
import { normalizeBody, htmlToText } from '../../src/modules/email/index.js';

// 006/D25 — body selection for a NEW inbound email: prefer the plain-text part, fall back to a crude
// HTML→text reduction only when there is no usable text (HTML-only mail). Deterministic, no network.
describe('email normalizeBody / htmlToText', () => {
  it('prefers the plain-text part when present', () => {
    expect(normalizeBody('  flat tire ', '<p>ignored</p>')).toBe('flat tire');
  });

  it('falls back to HTML→text only when text is empty/whitespace', () => {
    expect(normalizeBody('   ', '<p>Brake lever is <b>loose</b></p>')).toBe('Brake lever is loose');
    expect(normalizeBody('', undefined)).toBe('');
  });

  it('htmlToText drops script/style, turns block tags into newlines, and decodes common entities', () => {
    const html = '<style>.x{}</style><p>Hi &amp; welcome</p><script>evil()</script><div>line two</div>';
    const out = htmlToText(html);
    expect(out).toContain('Hi & welcome');
    expect(out).toContain('line two');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('<');
  });

  it('collapses excess whitespace but preserves paragraph breaks', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });
});
