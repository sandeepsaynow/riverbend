import { createServer, type Server } from 'node:http';

/**
 * Minimal health listener for the worker (D25). Cloud Run runs the worker as a *service* (runtime.tf),
 * and a Cloud Run service's startup/liveness probes require the container to accept connections on
 * `$PORT` — but the worker is a background pg-boss consumer with no HTTP API of its own. Without a
 * listener the worker revision never turns healthy and the deploy fails (a previously-reported GCP gap).
 *
 * This serves ONLY liveness/readiness — never tenant data, never ids. `/healthz` is always 200 once the
 * socket is open (satisfies the TCP/HTTP startup probe); `/readyz` reports 200 only after the queue and
 * all handlers are wired, 503 while starting. No request body is read and nothing is logged here (VII).
 */
export function startHealthServer(port: number, isReady: () => boolean): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"alive"}');
      return;
    }
    if (req.method === 'GET' && (path === '/readyz' || path === '/')) {
      const ready = isReady();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(ready ? '{"status":"ready"}' : '{"status":"starting"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  // Bind on all interfaces so the Cloud Run probe can reach it; default 8080 matches the injected PORT.
  server.listen(port);
  return server;
}
