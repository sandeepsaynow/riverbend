import { describe, it, expect } from 'vitest';
import { isNoReplyOrAuto } from '../../src/modules/email/index.js';

// D30 / FR-020 — never auto-reply to no-reply / bounce / system / list senders (loop + bounce safety).
describe('isNoReplyOrAuto (reply-safety guard)', () => {
  it('blocks no-reply / bounce / system / list senders', () => {
    for (const a of [
      'no-reply@shop.com', 'noreply@shop.com', 'donotreply@x.io', 'do-not-reply@x.io',
      'mailer-daemon@mail.example', 'MAILER-DAEMON@mail.example', 'postmaster@corp.com',
      'bounces@sendgrid.net', 'bounce@x.com', 'notifications@github.com', 'listserv@lists.org',
    ]) expect(isNoReplyOrAuto(a), a).toBe(true);
  });

  it('treats a missing/empty sender as unsafe (fail-closed → human review)', () => {
    expect(isNoReplyOrAuto('')).toBe(true);
    expect(isNoReplyOrAuto(null)).toBe(true);
    expect(isNoReplyOrAuto(undefined)).toBe(true);
  });

  it('allows ordinary customer senders (no false positives)', () => {
    for (const a of [
      'alice@gmail.com', 'bob.smith@outlook.com', 'rider123@yahoo.com', 'jane+bikes@me.com',
      'bouncer@club.com', 'announce.me@x.com', // contain substrings but not as bounded tokens
    ]) expect(isNoReplyOrAuto(a), a).toBe(false);
  });
});
