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

function formPage(
  shopName: string,
  slug: string,
  formToken: string,
  nonce: string,
  prefill?: { email?: string; description?: string; error?: string },
): string {
  const err = prefill?.error ? `<p role="alert" style="color:#b00">${escapeHtml(prefill.error)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book a repair — ${escapeHtml(shopName)}</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}input,textarea{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit}.hp{position:absolute;left:-5000px}</style></head>
<body><h1>${escapeHtml(shopName)}</h1><p>Tell us what your bike needs. We'll email you.</p>${err}
<form method="POST" action="/f/submit" id="f">
<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
<input type="hidden" name="slug" value="${escapeHtml(slug)}">
<input type="hidden" name="submission_id" id="sid" value="">
<input type="hidden" name="cf-turnstile-response" id="ts" value="offline-ok">
<label for="email">Your email (required)</label><input id="email" name="email" type="email" required value="${escapeHtml(prefill?.email ?? '')}">
<label for="description">What does your bike need? (required)</label><textarea id="description" name="description" rows="5" required>${escapeHtml(prefill?.description ?? '')}</textarea>
<div class="hp"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<button type="submit">Request a repair</button></form>
<script nonce="${nonce}">(function(){
// One FRESH operation id per form instance (D24). NOT persisted across submissions — a persistent id
// reused for a new request was the bug. A double-click or network retry of THIS page resubmits the same
// hidden value (idempotent); a new form load gets a new id; a Back/Forward (BFCache) restore regenerates.
var el=document.getElementById('sid');
function fresh(){return (window.crypto&&crypto.randomUUID&&crypto.randomUUID())||(String(Date.now())+Math.random());}
el.value=fresh();
window.addEventListener('pageshow',function(e){if(e.persisted)el.value=fresh();});
})();</script></body></html>`;
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
      // Post/Redirect/Get (D24): a success redirects to a GET status page, so a browser refresh re-reads
      // status instead of re-posting the form (a duplicate replay is harmless either way — same UUID).
      res.redirect(303, `/f/status/${encodeURIComponent(result.statusToken)}`);
    } catch (err) {
      if (err instanceof HoneypotRejected) {
        res.status(204).end(); // look successful; persist nothing
        return;
      }
      // Recoverable validation error: re-render the form with the user's input preserved + a fresh token.
      // The client script mints a fresh submission id, so correcting and resubmitting is a clean new attempt.
      if (err instanceof ValidationError) {
        const slug = String(body.slug ?? '');
        const shop = slug ? await deps.web.resolveShopBySlug(slug) : null;
        if (shop) {
          const token = deps.web.mintFormToken(shop.id);
          res.status(422).type('html').send(formPage(shop.displayName, slug, token, nonce, {
            email: body.email ?? '', description: body.description ?? '', error: err.message,
          }));
          return;
        }
      }
      const [status, msg] =
        err instanceof WebAuthError ? [401, 'Invalid or expired form.']
        : err instanceof ValidationError ? [422, escapeHtml(err.message)]
        : err instanceof ConflictError ? [409, 'This request was already received. To send a new one, reopen the form (it will use a new reference).']
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
    const another = st.slug ? `<p><a href="/f/${encodeURIComponent(st.slug)}">Submit another repair request</a></p>` : '';
    res.status(200).type('html').send(page('Request status', `<h1>Request status</h1><p>Current state: <strong>${escapeHtml(st.state)}</strong></p>${another}`, nonce));
  });

  app.use(r);
}
