import type { Db } from '../../platform/db/index.js';
import { IntakeService, MAX_CONTENT_CHARS, ValidationError } from '../intake/index.js';
import { mintFormToken, mintStatusToken, readFormToken, readStatusToken } from './tokens.js';
import type { TurnstileVerifier } from './turnstile.js';

export class WebAuthError extends Error {} // forged/invalid form token → 401
export class HoneypotRejected extends Error {} // bot filled the honeypot → silent success (204)
export class TurnstileFailed extends Error {} // bot check failed → 403

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WebSubmitInput {
  formToken: string;
  email: string;
  description: string;
  submissionId: string;
  honeypot?: string; // the "website" field; must be empty
  turnstileToken: string;
  remoteIp?: string;
}
export interface WebSubmitResult {
  requestId: string;
  statusToken: string;
  duplicate: boolean;
}

/**
 * Public web intake (D11). Shop identity comes ONLY from the HMAC-signed form token (Constitution III);
 * email is mandatory (I8). Reuses `IntakeService.submit` with `source='web'`, so idempotency, atomic
 * write and the queue are the same as every other channel.
 */
export class WebService {
  constructor(
    private readonly db: Db,
    private readonly intake: IntakeService,
    private readonly deps: { signingKey: string; turnstile: TurnstileVerifier },
  ) {}

  /** Resolve a shop for rendering the form (admin-path read; shops are provisioned cross-shop, D2). */
  async resolveShopBySlug(slug: string): Promise<{ id: string; displayName: string } | null> {
    const r = await this.db.adminQuery<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM shops WHERE slug = $1`,
      [slug],
    );
    const row = r.rows[0];
    return row ? { id: row.id, displayName: row.display_name } : null;
  }

  mintFormToken(shopId: string): string {
    return mintFormToken(this.deps.signingKey, shopId);
  }

  async submit(input: WebSubmitInput): Promise<WebSubmitResult> {
    // Honeypot first: a filled hidden field means a bot; look successful but persist nothing.
    if (input.honeypot && input.honeypot.trim() !== '') throw new HoneypotRejected();

    const shopId = readFormToken(this.deps.signingKey, input.formToken);
    if (!shopId) throw new WebAuthError('invalid form token');

    const email = input.email?.trim() ?? '';
    if (!EMAIL_RE.test(email)) throw new ValidationError('a valid email is required');
    const description = input.description ?? '';
    if (description.trim() === '') throw new ValidationError('a repair description is required');
    if (description.length > MAX_CONTENT_CHARS) throw new ValidationError(`description exceeds ${MAX_CONTENT_CHARS} characters`);
    if (!input.submissionId || input.submissionId.trim() === '') throw new ValidationError('submission_id is required');

    const ok = await this.deps.turnstile.verify(input.turnstileToken, input.remoteIp);
    if (!ok) throw new TurnstileFailed('bot check failed');

    const res = await this.intake.submit({
      shopId,
      source: 'web',
      submissionId: input.submissionId,
      content: description,
      customerEmail: email,
    });
    return {
      requestId: res.requestId,
      statusToken: mintStatusToken(this.deps.signingKey, shopId, res.requestId),
      duplicate: res.duplicate,
    };
  }

  /** Read status for a signed status token (no shop secret; tenant-scoped by the embedded shop id).
   *  Returns the shop `slug` too, so the status page can link back to a FRESH form (new operation id). */
  async status(token: string): Promise<{ state: string; slug: string | null } | null> {
    const parsed = readStatusToken(this.deps.signingKey, token);
    if (!parsed) return null;
    const st = await this.intake.getRequestStatus(parsed.shopId, parsed.requestId);
    if (!st) return null;
    const s = await this.db.adminQuery<{ slug: string }>(`SELECT slug FROM shops WHERE id = $1`, [parsed.shopId]);
    return { state: st.state, slug: s.rows[0]?.slug ?? null };
  }
}
