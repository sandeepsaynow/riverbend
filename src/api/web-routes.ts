import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { HoneypotRejected, TurnstileFailed, WebAuthError, type WebService } from '../modules/web/index.js';
import { ConflictError, ValidationError } from '../modules/intake/index.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function cspPage(res: Response, nonce: string): void {
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function formPage(shopName: string, slug: string, formToken: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book a repair — ${escapeHtml(shopName)}</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}input,textarea{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit}.hp{position:absolute;left:-5000px}</style></head>
<body><h1>${escapeHtml(shopName)}</h1><p>Tell us what your bike needs. We'll email you.</p>
<form method="POST" action="/f/submit" id="f">
<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
<input type="hidden" name="submission_id" id="sid" value="">
<input type="hidden" name="cf-turnstile-response" id="ts" value="offline-ok">
<label for="email">Your email (required)</label><input id="email" name="email" type="email" required>
<label for="description">What does your bike need? (required)</label><textarea id="description" name="description" rows="5" required></textarea>
<div class="hp"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<button type="submit">Request a repair</button></form>
<script nonce="${nonce}">(function(){var k='rb_sid_${escapeHtml(slug)}';var v=null;try{v=localStorage.getItem(k)}catch(e){}
if(!v){v=(crypto.randomUUID&&crypto.randomUUID())||String(Date.now())+Math.random();try{localStorage.setItem(k,v)}catch(e){}}
document.getElementById('sid').value=v;})();</script></body></html>`;
}

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}</style></head>
<body>${body}</body></html>`;
}

/**
 * Public web form routes (D11). Mounted at /f, OUTSIDE shop auth. Shop identity comes only from the
 * signed form token. Stricter rate limiting + optional origin allowlist defend the submit endpoint.
 */
export function registerWebRoutes(
  app: express.Express,
  deps: { web: WebService; allowedOrigins?: string[] },
): void {
  const r: Router = express.Router();
  r.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const submitLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  const originOk = (req: Request): boolean => {
    const allow = deps.allowedOrigins;
    if (!allow || allow.length === 0) return true; // not configured → allow (dev/local)
    const origin = req.get('origin');
    if (!origin) return true; // same-origin form posts often omit Origin
    try {
      return allow.includes(new URL(origin).host) || allow.includes(origin);
    } catch {
      return false;
    }
  };

  r.get('/f/:slug', async (req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    cspPage(res, nonce);
    const slug = String(req.params.slug ?? '');
    const shop = await deps.web.resolveShopBySlug(slug);
    if (!shop) {
      res.status(404).type('html').send(page('Not found', '<h1>Shop not found</h1>', nonce));
      return;
    }
    const token = deps.web.mintFormToken(shop.id);
    res.status(200).type('html').send(formPage(shop.displayName, slug, token, nonce));
  });

  r.post('/f/submit', submitLimiter, async (req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    cspPage(res, nonce);
    if (!originOk(req)) {
      res.status(403).type('html').send(page('Blocked', '<h1>Request blocked</h1>', nonce));
      return;
    }
    const body = req.body as Record<string, string>;
    try {
      const result = await deps.web.submit({
        formToken: body.form_token ?? '',
        email: body.email ?? '',
        description: body.description ?? '',
        submissionId: body.submission_id ?? '',
        honeypot: body.website ?? '',
        turnstileToken: body['cf-turnstile-response'] ?? '',
        ...(req.ip ? { remoteIp: req.ip } : {}),
      });
      const link = `/f/status/${encodeURIComponent(result.statusToken)}`;
      res.status(result.duplicate ? 200 : 202).type('html').send(
        page('Request received', `<h1>Thanks — we've got it.</h1><p>We'll email you.</p>
<p><a href="${link}">Track your request</a></p>`, nonce),
      );
    } catch (err) {
      if (err instanceof HoneypotRejected) {
        res.status(204).end(); // look successful; persist nothing
        return;
      }
      const [status, msg] =
        err instanceof WebAuthError ? [401, 'Invalid or expired form.']
        : err instanceof ValidationError ? [422, escapeHtml(err.message)]
        : err instanceof ConflictError ? [409, 'This submission was already received with different text.']
        : err instanceof TurnstileFailed ? [403, 'Bot check failed. Please try again.']
        : [500, 'Something went wrong.'];
      res.status(status as number).type('html').send(page('Could not submit', `<h1>Could not submit</h1><p>${msg as string}</p>`, nonce));
    }
  });

  r.get('/f/status/:token', async (req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    cspPage(res, nonce);
    const st = await deps.web.status(String(req.params.token ?? ''));
    if (!st) {
      res.status(404).type('html').send(page('Not found', '<h1>Request not found</h1>', nonce));
      return;
    }
    res.status(200).type('html').send(page('Request status', `<h1>Request status</h1><p>Current state: <strong>${escapeHtml(st.state)}</strong></p>`, nonce));
  });

  app.use(r);
}
