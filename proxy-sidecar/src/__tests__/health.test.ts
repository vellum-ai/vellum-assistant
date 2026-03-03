import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createHealthServer } from '../health.js';

/**
 * Helper: make an HTTP request to the health server and return the response.
 */
function request(
  port: number,
  path: string,
  method: string = 'GET',
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests with proxy "ready"
// ---------------------------------------------------------------------------

describe('health server (proxy ready)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createHealthServer({ isReady: () => true });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /healthz returns 200 with status ok', async () => {
    const res = await request(port, '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('GET /readyz returns 200 when proxy is ready', async () => {
    const res = await request(port, '/readyz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ready' });
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await request(port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('returns 405 for non-GET methods', async () => {
    const res = await request(port, '/healthz', 'POST');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
  });

  it('returns 404 for root path', async () => {
    const res = await request(port, '/');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests with proxy "not ready"
// ---------------------------------------------------------------------------

describe('health server (proxy not ready)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createHealthServer({ isReady: () => false });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /healthz still returns 200 (process is alive)', async () => {
    const res = await request(port, '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 503 when proxy is not ready', async () => {
    const res = await request(port, '/readyz');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'not_ready' });
  });
});

// ---------------------------------------------------------------------------
// Dynamic readiness transition
// ---------------------------------------------------------------------------

describe('health server (dynamic readiness)', () => {
  let server: http.Server;
  let port: number;
  let ready = false;

  beforeAll(async () => {
    server = createHealthServer({ isReady: () => ready });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('reflects readiness changes dynamically', async () => {
    // Initially not ready
    let res = await request(port, '/readyz');
    expect(res.status).toBe(503);

    // Transition to ready
    ready = true;
    res = await request(port, '/readyz');
    expect(res.status).toBe(200);

    // Transition back to not ready (e.g., during shutdown)
    ready = false;
    res = await request(port, '/readyz');
    expect(res.status).toBe(503);
  });
});
