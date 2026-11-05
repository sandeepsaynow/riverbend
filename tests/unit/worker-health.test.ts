import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { startHealthServer } from '../../src/worker/health-server.js';

// D25 — the worker runs as a Cloud Run *service*; its startup/liveness probes need a listener on $PORT.
// This verifies the minimal health server answers liveness always and readiness only once wired.
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

describe('worker health-server', () => {
  it('serves /healthz 200 as soon as it is listening, regardless of readiness', async () => {
    server = startHealthServer(0, () => false);
    const port = (server.address() as AddressInfo).port;
    const r = await get(port, '/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toContain('alive');
  });

  it('reports /readyz 503 while starting, then 200 once ready flips true', async () => {
    let ready = false;
    server = startHealthServer(0, () => ready);
    const port = (server.address() as AddressInfo).port;
    expect((await get(port, '/readyz')).status).toBe(503);
    ready = true;
    const ok = await get(port, '/readyz');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('ready');
  });

  it('returns 404 for unknown paths and never exposes anything else', async () => {
    server = startHealthServer(0, () => true);
    const port = (server.address() as AddressInfo).port;
    expect((await get(port, '/secrets')).status).toBe(404);
  });
});
