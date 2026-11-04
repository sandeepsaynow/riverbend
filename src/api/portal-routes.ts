import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { fromNodeHeaders, normalizeOrigin, type Auth } from '../platform/auth/better-auth.js';

const CSRF_COOKIE = 'rb_csrf';
/** Read one cookie value from the raw Cookie header (no cookie-parser dependency). */
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function ctEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
import { AuthPortalService, AlreadyInitialized, RecoveryRequired } from '../modules/portal/service.js';
import type { OrdersService } from '../modules/orders/index.js';
import type { ShopsService } from '../modules/shops/index.js';
import type { Db } from '../platform/db/index.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;max-width:52rem;margin:1.5rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.35rem .5rem;text-align:left}label{display:block;margin:.6rem 0 .2rem;font-weight:600}input,select{padding:.4rem;font:inherit;min-width:18rem}nav a{margin-right:1rem}</style>
</head><body>${body}</body></html>`;
}
/** Hidden CSRF field for a form (double-submit token; pairs with the rb_csrf cookie). */
function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}
function loginForm(action: string, title: string, csrfToken: string): string {
  return page(title, `<h1>${esc(title)}</h1><form method="POST" action="${action}">${csrfField(csrfToken)}
<label>Email</label><input name="email" type="email" required>
<label>Password</label><input name="password" type="password" required>
<button type="submit">Sign in</button></form>`);
}

interface PortalDeps {
  auth: Auth;
  portal: AuthPortalService;
  orders: OrdersService;
  shops: ShopsService;
  db: Db;
  bootstrapToken: string;
  trustedOrigins: string[]; // exact scheme://host:port allowlist for Origin/Referer checks (D20.2)
  secureCookies: boolean; // Secure flag on the CSRF cookie in production (D20.3)
}

/** Mounted in the composition layer (after express.json). Session-guarded server-rendered portal (010). */
export function registerPortalRoutes(app: express.Express, deps: PortalDeps): void {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const getSession = (req: Request) => deps.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  const allow = new Set(deps.trustedOrigins);

  // Issue a per-page CSRF token: set it as an HttpOnly, SameSite=Lax cookie AND return it to embed in the
  // form (double-submit). HttpOnly is safe because the SERVER echoes it into the field — JS never reads it.
  const issueCsrf = (res: Response): string => {
    const token = randomBytes(32).toString('base64url');
    res.append('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${deps.secureCookies ? '; Secure' : ''}`);
    return token;
  };

  /**
   * CSRF guard for our OWN session/cookie-authenticated state-changing POSTs (D20.3). Two independent layers:
   *  1) Origin/Referer defense-in-depth — a PRESENT, parseable Origin (or, if absent, Referer) must be in the
   *     exact scheme://host:port allowlist. `Origin: null` (opaque context — e.g. Referrer-Policy: no-referrer)
   *     is not parseable, so it is NOT trusted on its own and falls through to the token.
   *  2) Double-submit token (PRIMARY, origin-independent) — the `rb_csrf` cookie must equal the `_csrf` field.
   *     A cross-site POST cannot read the HttpOnly cookie or the hidden field, and SameSite=Lax withholds the
   *     cookie on cross-site POSTs, so a forgery can never present a matching pair — even with `Origin: null`.
   * Both must pass. (Bootstrap-token-gated /admin/init is NOT cookie-authenticated, so it does not use this.)
   */
  const csrf = (req: Request, res: Response, next: NextFunction): void => {
    const reject = (): void => { res.status(403).type('html').send(page('Blocked', '<h1>Request blocked</h1>')); };
    const origin = req.get('origin');
    if (origin) {
      const n = normalizeOrigin(origin); // 'null'/opaque → null → defer to the token (do not hard-reject)
      if (n !== null && !allow.has(n)) return reject(); // a real, foreign origin is refused outright
    } else {
      const referer = req.get('referer');
      if (referer) { const n = normalizeOrigin(referer); if (n === null || !allow.has(n)) return reject(); }
    }
    const cookieTok = readCookie(req, CSRF_COOKIE);
    const bodyTok = (req.body as { _csrf?: string } | undefined)?._csrf;
    if (!cookieTok || !bodyTok || !ctEqual(cookieTok, bodyTok)) return reject();
    next();
  };

  async function requireStaff(req: Request, res: Response): Promise<{ userId: string; shopId: string; role: string } | null> {
    const s = (await getSession(req)) as { user?: { id: string; banned?: boolean } } | null;
    if (!s?.user || s.user.banned) { res.redirect('/staff/login'); return null; }
    const memberships = await deps.portal.membershipsFor(s.user.id);
    if (memberships.length === 0) { res.status(403).type('html').send(page('No access', '<h1>No shop access</h1>')); return null; }
    const requested = typeof req.query.shop === 'string' ? req.query.shop : undefined;
    const chosen = (requested && memberships.find((m) => m.shopId === requested)) || memberships[0]!; // authorized selector only
    return { userId: s.user.id, shopId: chosen.shopId, role: chosen.role };
  }

  async function forwardSignIn(req: Request, res: Response, redirectTo: string): Promise<void> {
    const body = req.body as { email?: string; password?: string };
    try {
      const resp = await deps.auth.api.signInEmail({ body: { email: body.email ?? '', password: body.password ?? '' }, asResponse: true });
      for (const c of resp.headers.getSetCookie?.() ?? []) res.append('set-cookie', c);
      if (resp.status >= 400) { res.status(401).type('html').send(loginForm(req.path, 'Sign in — try again', issueCsrf(res))); return; }
      res.redirect(redirectTo);
    } catch {
      res.status(401).type('html').send(loginForm(req.path, 'Sign in — try again', issueCsrf(res))); // generic error (no enumeration)
    }
  }

  // --- One-time admin bootstrap (operator; bootstrap-token gated, single-use) ---
  r.post('/admin/init', async (req: Request, res: Response) => { // bootstrap-token-gated (secret, not cookie) → no CSRF needed
    const token = (req.get('x-bootstrap-token') ?? (req.body as { bootstrap_token?: string }).bootstrap_token ?? '');
    if (!deps.bootstrapToken || token !== deps.bootstrapToken) { res.status(401).json({ error: 'unauthorized' }); return; }
    const b = req.body as { email?: string; password?: string; name?: string };
    try {
      const { userId } = await deps.portal.initFirstAdmin({ email: b.email ?? '', password: b.password ?? '', name: b.name ?? 'Admin' });
      res.status(201).json({ status: 'initialized', user_id: userId });
    } catch (err) {
      if (err instanceof AlreadyInitialized) { res.status(409).json({ error: 'already_initialized' }); return; }
      if (err instanceof RecoveryRequired) { res.status(409).json({ error: 'recovery_required', message: (err as Error).message }); return; }
      res.status(400).json({ error: 'init_failed' }); // retryable: the marker stays PENDING (no lockout)
    }
  });

  // --- Admin portal ---
  r.get('/admin/login', (_req, res) => res.type('html').send(loginForm('/admin/login', 'Admin login', issueCsrf(res))));
  r.post('/admin/login', csrf, (req, res) => void forwardSignIn(req, res, '/admin'));
  r.get('/admin', async (req, res) => {
    const s = (await getSession(req)) as { user?: { role?: string } } | null;
    if (s?.user?.role !== 'admin') { res.redirect('/admin/login'); return; }
    const shops = await deps.shops.listShops().catch(() => []);
    res.type('html').send(page('Admin', `<h1>Admin</h1><nav><a href="/admin/staff">Staff</a></nav>
<h2>Shops</h2><ul>${shops.map((sh) => `<li>${esc(sh.slug)}</li>`).join('')}</ul>`));
  });
  r.get('/admin/staff', async (req, res) => {
    const s = (await getSession(req)) as { user?: { role?: string } } | null;
    if (s?.user?.role !== 'admin') { res.redirect('/admin/login'); return; }
    const staff = await deps.portal.listStaff();
    const tok = issueCsrf(res);
    const rows = staff.map((x) => `<tr><td>${esc(x.email)}</td><td>${esc(x.role)}</td><td>${esc(x.status)}</td>
<td><form method="POST" action="/admin/staff/${esc(x.userId)}/disable" style="margin:0">${csrfField(tok)}<button ${x.status !== 'active' ? 'disabled' : ''}>disable</button></form></td></tr>`).join('');
    const shopOpts = (await deps.shops.listShops().catch(() => [])).map((sh) => `<option value="${esc(sh.id)}">${esc(sh.slug)}</option>`).join('');
    res.type('html').send(page('Staff', `<h1>Staff</h1><nav><a href="/admin">Admin</a><form method="POST" action="/admin/logout" style="display:inline">${csrfField(tok)}<button>Log out</button></form></nav>
<table><tr><th>email</th><th>role</th><th>status</th><th></th></tr>${rows}</table>
<h2>Create staff</h2><form method="POST" action="/admin/staff">${csrfField(tok)}
<label>Email</label><input name="email" type="email" required><label>Name</label><input name="name" required>
<label>Password (min 12)</label><input name="password" type="password" minlength="12" required>
<label>Shop</label><select name="shop_id" required>${shopOpts}</select>
<label>Role</label><select name="role"><option>SHOP_STAFF</option><option>SHOP_ADMIN</option></select>
<button type="submit">Create</button></form>`));
  });
  r.post('/admin/staff', csrf, async (req, res) => {
    const s = (await getSession(req)) as { user?: { role?: string } } | null;
    if (s?.user?.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return; }
    const b = req.body as Record<string, string>;
    const role = b.role === 'SHOP_ADMIN' ? 'SHOP_ADMIN' : 'SHOP_STAFF'; // allow-list; never PLATFORM_ADMIN here
    try {
      await deps.portal.createStaff({ email: b.email ?? '', name: b.name ?? '', password: b.password ?? '', shopId: b.shop_id ?? '', role });
      res.redirect('/admin/staff');
    } catch { res.status(400).type('html').send(page('Create failed', '<h1>Could not create staff</h1><p>Email may already exist.</p>')); }
  });
  r.post('/admin/staff/:id/disable', csrf, async (req, res) => {
    const s = (await getSession(req)) as { user?: { role?: string } } | null;
    if (s?.user?.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      await deps.portal.disableStaff(String(req.params.id), fromNodeHeaders(req.headers));
    } catch {
      res.status(500).json({ error: 'disable_failed' });
      return;
    }
    res.redirect('/admin/staff');
  });

  // --- Staff portal ---
  r.get('/staff/login', (_req, res) => res.type('html').send(loginForm('/staff/login', 'Staff login', issueCsrf(res))));
  r.post('/staff/login', csrf, (req, res) => void forwardSignIn(req, res, '/staff'));
  // Logout is state-changing → POST + CSRF (not GET, which is CSRF-forgeable and prefetchable).
  const doLogout = async (req: Request, res: Response, to: string): Promise<void> => {
    try { await deps.auth.api.signOut({ headers: fromNodeHeaders(req.headers) }); } catch { /* ignore */ }
    res.append('Set-Cookie', `${CSRF_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(to);
  };
  r.post('/staff/logout', csrf, (req, res) => void doLogout(req, res, '/staff/login'));
  r.post('/admin/logout', csrf, (req, res) => void doLogout(req, res, '/admin/login'));

  r.get('/staff', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const { orders, shop_total_cents } = await deps.orders.listOpenOrders(ctx.shopId);
    const na = await deps.orders.needsAttention(ctx.shopId);
    res.type('html').send(page('Staff dashboard', `<h1>Dashboard</h1><nav><a href="/staff/requests">Requests</a><a href="/staff/orders">Orders</a><a href="/staff/needs-attention">Needs attention</a><a href="/staff/usage">Usage</a><form method="POST" action="/staff/logout" style="display:inline">${csrfField(issueCsrf(res))}<button>Log out</button></form></nav>
<p>Open work orders: <strong>${orders.length}</strong> (total ${(shop_total_cents / 100).toFixed(2)}) · Needs attention: <strong>${na.length}</strong></p>`));
  });
  r.get('/staff/orders', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const { orders } = await deps.orders.listOpenOrders(ctx.shopId);
    const rows = orders.map((o) => `<tr><td>${esc(String((o as { request_id?: string }).request_id ?? ''))}</td><td>${esc(JSON.stringify((o as { items?: unknown }).items ?? []))}</td><td>${(((o as { order_total_cents?: number }).order_total_cents ?? 0) / 100).toFixed(2)}</td></tr>`).join('');
    res.type('html').send(page('Orders', `<h1>Open work orders</h1><p><a href="/staff">← dashboard</a></p><table><tr><th>request</th><th>items</th><th>total</th></tr>${rows}</table>`));
  });
  r.get('/staff/needs-attention', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const items = await deps.orders.needsAttention(ctx.shopId);
    const rows = items.map((i) => `<tr><td>${esc(String((i as { request_id?: string }).request_id ?? ''))}</td><td>${esc(String((i as { reason?: string }).reason ?? ''))}</td></tr>`).join('');
    res.type('html').send(page('Needs attention', `<h1>Needs attention</h1><p><a href="/staff">← dashboard</a></p><table><tr><th>request</th><th>reason</th></tr>${rows}</table>`));
  });

  r.get('/staff/requests', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const rows = await deps.db.withTenant(ctx.shopId, (c) => c.query<{ id: string; state: string; source: string; customer_email: string | null; received_at: string }>(
      `SELECT r.id, r.state, m.source, m.customer_email, m.received_at FROM requests r JOIN messages m ON m.id=r.message_id ORDER BY m.received_at DESC LIMIT 50`));
    const body = rows.rows.map((x) => `<tr><td><a href="/staff/requests/${esc(x.id)}">${esc(x.id.slice(0, 8))}…</a></td><td>${esc(x.state)}</td><td>${esc(x.source)}</td><td>${esc(x.customer_email ?? '')}</td></tr>`).join('');
    res.type('html').send(page('Requests', `<h1>Recent requests</h1><p><a href="/staff">← dashboard</a></p><table><tr><th>id</th><th>state</th><th>source</th><th>email</th></tr>${body}</table>`));
  });

  r.get('/staff/requests/:id', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const id = String(req.params.id);
    const data = await deps.db.withTenant(ctx.shopId, async (c) => {
      const req0 = await c.query<{ state: string; last_error: string | null; content: string; customer_email: string | null }>(
        `SELECT r.state, r.last_error, m.content, m.customer_email FROM requests r JOIN messages m ON m.id=r.message_id WHERE r.id=$1`, [id]);
      const ex = await c.query<{ kind: string; bikes: unknown; flagged: boolean }>(`SELECT kind, bikes, flagged FROM extractions WHERE request_id=$1`, [id]);
      const fu = await c.query<{ question: string; reply_content: string | null }>(`SELECT question, reply_content FROM follow_ups WHERE request_id=$1`, [id]);
      return { r: req0.rows[0], ex: ex.rows[0], fu: fu.rows[0] };
    });
    if (!data.r) { res.status(404).type('html').send(page('Not found', '<h1>Request not found</h1>')); return; }
    const { orders: ords } = await deps.orders.listOpenOrders(ctx.shopId);
    const mine = ords.filter((o) => (o as { request_id?: string }).request_id === id);
    res.type('html').send(page('Request', `<h1>Request ${esc(id.slice(0, 8))}…</h1><p><a href="/staff/requests">← requests</a></p>
<p><strong>State:</strong> ${esc(data.r.state)}${data.r.last_error ? ` (${esc(data.r.last_error)})` : ''}</p>
<p><strong>Customer:</strong> ${esc(data.r.customer_email ?? '(none)')}</p>
<h3>Original message</h3><pre>${esc(data.r.content)}</pre>
<h3>AI extraction (code-validated)</h3><pre>${esc(data.ex ? JSON.stringify({ kind: data.ex.kind, flagged: data.ex.flagged, bikes: data.ex.bikes }, null, 2) : '(none)')}</pre>
${data.fu ? `<h3>Clarification</h3><p>Q: ${esc(data.fu.question)}</p><p>A: ${esc(data.fu.reply_content ?? '(awaiting)')}</p>` : ''}
<h3>Work orders</h3><pre>${esc(JSON.stringify(mine, null, 2))}</pre>`));
  });

  r.get('/staff/usage', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const period = new Date().toISOString().slice(0, 7);
    const u = await deps.db.withTenant(ctx.shopId, (c) => c.query<{ spent: string | null; calls: string }>(
      `SELECT sum(cost_micros)::text AS spent, count(*)::text AS calls FROM llm_calls WHERE period=$1`, [period]));
    const spent = Number(u.rows[0]!.spent ?? 0);
    res.type('html').send(page('AI usage', `<h1>AI usage (${esc(period)})</h1><p><a href="/staff">← dashboard</a></p>
<p>Recorded proxy-calculated spend this period: <strong>${spent} micros ($${(spent / 1e6).toFixed(4)})</strong> over ${esc(u.rows[0]!.calls)} call(s).</p>
<p><em>Note:</em> LiteLLM enforces the per-shop monthly cap; spend is eventually-consistent (a bounded one-in-flight-call soft-cap). No provider/LiteLLM keys are shown here.</p>`));
  });

  app.use(r);
}
