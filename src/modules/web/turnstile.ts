/**
 * Bot-check behind an interface (D11): a deterministic fake passes in tests/local (no key, no network);
 * the real Cloudflare Turnstile verifier is used only when TURNSTILE_SECRET is configured. The gateway
 * pattern keeps the provider a two-way-door choice (Principle IV).
 */
export interface TurnstileVerifier {
  /** Verify a client token server-side. Returns true if human/valid. */
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

/** Offline default: accepts any non-empty token, rejects empty. Deterministic for tests. */
export class FakeTurnstileVerifier implements TurnstileVerifier {
  async verify(token: string): Promise<boolean> {
    return typeof token === 'string' && token.trim().length > 0;
  }
}

/** Real adapter: POST to Cloudflare siteverify. Used only when a secret is configured. */
export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  constructor(private readonly secret: string) {}
  async verify(token: string, remoteIp?: string): Promise<boolean> {
    if (!token) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { success?: boolean };
      return json.success === true;
    } catch {
      return false; // fail closed on verifier outage
    }
  }
}
