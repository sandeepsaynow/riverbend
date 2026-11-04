import express, { type Request, type Response, type NextFunction } from 'express';
import { fromNodeHeaders, type Auth } from '../platform/auth/better-auth.js';
import { AuthPortalService, AlreadyInitialized } from '../modules/portal/service.js';
import type { OrdersService } from '../modules/orders/index.js';
import type { ShopsService } from '../modules/shops/index.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;max-width:52rem;margin:1.5rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.35rem .5rem;text-align:left}label{display:block;margin:.6rem 0 .2rem;font-weight:600}input,select{padding:.4rem;font:inherit;min-width:18rem}nav a{margin-right:1rem}</style>
</head><body>${body}</body></html>`;
}
function loginForm(action: string, title: string): string {
  return page(title, `<h1>${esc(title)}</h1><form method="POST" action="${action}">
<label>Email</label><input name="email" type="email" required>
<label>Password</label><input name="password" type="password" required>
<button type="submit">Sign in</button></form>`);
}

interface PortalDeps {
  auth: Auth;
  portal: AuthPortalService;
  orders: OrdersService;
  shops: ShopsService;
  bootstrapToken: string;
  baseUrlHost: string; // for Origin checks on state-changing POSTs
}

/** Mounted in the composition layer (after express.json). Session-guarded server-rendered portal (010). */
export function registerPortalRoutes(app: express.Express, deps: PortalDeps): void {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const getSession = (req: Request) => deps.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  // CSRF/Origin guard for our OWN state-changing HTML POSTs (Better Auth guards its own /api/auth routes).
  const sameOrigin = (req: Request): boolean => {
    const origin = req.get('origin');
    if (!origin) return true; // same-origin form posts often omit Origin
    try { return new URL(origin).host === deps.baseUrlHost; } catch { return false; }
  };
  const csrf = (req: Request, res: Response, next: NextFunction): void => {
    if (!sameOrigin(req)) { res.status(403).type('html').send(page('Blocked', '<h1>Request blocked</h1>')); return; }
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
      if (resp.status >= 400) { res.status(401).type('html').send(loginForm(req.path, 'Sign in — try again')); return; }
      res.redirect(redirectTo);
    } catch {
      res.status(401).type('html').send(loginForm(req.path, 'Sign in — try again')); // generic error (no enumeration)
    }
  }

  // --- One-time admin bootstrap (operator; bootstrap-token gated, single-use) ---
  r.post('/admin/init', csrf, async (req: Request, res: Response) => {
    const token = (req.get('x-bootstrap-token') ?? (req.body as { bootstrap_token?: string }).bootstrap_token ?? '');
    if (!deps.bootstrapToken || token !== deps.bootstrapToken) { res.status(401).json({ error: 'unauthorized' }); return; }
    const b = req.body as { email?: string; password?: string; name?: string };
    try {
      const { userId } = await deps.portal.initFirstAdmin({ email: b.email ?? '', password: b.password ?? '', name: b.name ?? 'Admin' });
      res.status(201).json({ status: 'initialized', user_id: userId });
    } catch (err) {
      if (err instanceof AlreadyInitialized) { res.status(409).json({ error: 'already_initialized' }); return; }
      res.status(400).json({ error: 'init_failed' });
    }
  });

  // --- Admin portal ---
  r.get('/admin/login', (_req, res) => res.type('html').send(loginForm('/admin/login', 'Admin login')));
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
    const rows = staff.map((x) => `<tr><td>${esc(x.email)}</td><td>${esc(x.role)}</td><td>${esc(x.status)}</td>
<td><form method="POST" action="/admin/staff/${esc(x.userId)}/disable" style="margin:0"><button ${x.status !== 'active' ? 'disabled' : ''}>disable</button></form></td></tr>`).join('');
    const shopOpts = (await deps.shops.listShops().catch(() => [])).map((sh) => `<option value="${esc(sh.id)}">${esc(sh.slug)}</option>`).join('');
    res.type('html').send(page('Staff', `<h1>Staff</h1><table><tr><th>email</th><th>role</th><th>status</th><th></th></tr>${rows}</table>
<h2>Create staff</h2><form method="POST" action="/admin/staff">
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
  r.get('/staff/login', (_req, res) => res.type('html').send(loginForm('/staff/login', 'Staff login')));
  r.post('/staff/login', csrf, (req, res) => void forwardSignIn(req, res, '/staff'));
  r.get('/staff/logout', async (req, res) => { try { await deps.auth.api.signOut({ headers: fromNodeHeaders(req.headers) }); } catch { /* ignore */ } res.redirect('/staff/login'); });

  r.get('/staff', async (req, res) => {
    const ctx = await requireStaff(req, res); if (!ctx) return;
    const { orders, shop_total_cents } = await deps.orders.listOpenOrders(ctx.shopId);
    const na = await deps.orders.needsAttention(ctx.shopId);
    res.type('html').send(page('Staff dashboard', `<h1>Dashboard</h1><nav><a href="/staff/orders">Orders</a><a href="/staff/needs-attention">Needs attention</a><a href="/staff/logout">Log out</a></nav>
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

  app.use(r);
}
