import http, {
  createServer,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { afterEach, describe, expect, test } from 'bun:test';

import { createProxyServer } from '../server.js';

/** Shape of the JSON body echoed by the upstream test server. */
interface EchoBody {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Start an HTTP server and return its URL + cleanup handle. */
function listenEphemeral(
  server: Server,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
    server.on('error', reject);
  });
}

/** Collect the full body of an IncomingMessage. */
function readBody(msg: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    msg.on('data', (c: Buffer) => chunks.push(c));
    msg.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

/**
 * Send an HTTP proxy request (absolute-URL form) and return the response.
 */
function proxyRequest(
  proxyUrl: string,
  targetUrl: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(proxyUrl);
    const req = http.request(
      {
        hostname,
        port: Number(port),
        path: targetUrl,
        method,
        headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('http-forwarder', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close().catch(() => {})));
    servers.length = 0;
  });

  async function setupPair(policyCallback?: Parameters<typeof createProxyServer>[0] extends infer T ? T extends { policyCallback?: infer P } ? P : never : never) {
    // Upstream echo server
    const upstream = createServer(async (req, res) => {
      const body = await readBody(req);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Echo': 'true',
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        }),
      );
    });
    const up = await listenEphemeral(upstream);
    servers.push(up);

    // Proxy
    const proxy = createProxyServer({ policyCallback });
    const px = await listenEphemeral(proxy);
    servers.push(px);

    return { upstreamUrl: up.url, proxyUrl: px.url };
  }

  test('simple GET forwarded correctly', async () => {
    const { upstreamUrl, proxyUrl } = await setupPair();

    const response = await proxyRequest(
      proxyUrl,
      `${upstreamUrl}/hello?a=1`,
      'GET',
      { 'X-Custom': 'test-value' },
    );

    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as EchoBody;
    expect(data.method).toBe('GET');
    expect(data.url).toBe('/hello?a=1');
    expect(data.headers['x-custom']).toBe('test-value');
  });

  test('POST with body forwarded correctly', async () => {
    const { upstreamUrl, proxyUrl } = await setupPair();

    const response = await proxyRequest(
      proxyUrl,
      `${upstreamUrl}/submit`,
      'POST',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ key: 'value' }),
    );

    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as EchoBody;
    expect(data.method).toBe('POST');
    expect(data.url).toBe('/submit');
    expect(data.body).toBe('{"key":"value"}');
  });

  test('error response forwarded correctly', async () => {
    // Upstream that returns 404
    const upstream = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    const up = await listenEphemeral(upstream);
    servers.push(up);

    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    servers.push(px);

    const response = await proxyRequest(
      px.url,
      `${up.url}/missing`,
      'GET',
    );

    expect(response.status).toBe(404);
    expect(response.body).toBe('Not Found');
  });

  test('upstream connection failure returns 502', async () => {
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    servers.push(px);

    const response = await proxyRequest(
      px.url,
      'http://127.0.0.1:1/unreachable',
      'GET',
    );

    expect(response.status).toBe(502);
    expect(response.body).toBe('Bad Gateway');
  });

  test('hop-by-hop headers are stripped from forwarded request', async () => {
    const { upstreamUrl, proxyUrl } = await setupPair();

    const response = await proxyRequest(
      proxyUrl,
      `${upstreamUrl}/headers`,
      'GET',
      {
        'X-Custom': 'keep-me',
        'Proxy-Authorization': 'secret',
      },
    );

    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as EchoBody;
    expect(data.headers['x-custom']).toBe('keep-me');
    expect(data.headers['proxy-authorization']).toBeUndefined();
  });

  test('non-HTTP protocol rejected with 400', async () => {
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    servers.push(px);

    // Use raw http.request to send a HTTPS URL as the path,
    // which the forwarder should reject since only HTTP is supported.
    const { hostname, port } = new URL(px.url);
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const socket = new (require('node:net').Socket)();
        socket.connect(Number(port), hostname, () => {
          socket.write(
            'GET https://example.com/path HTTP/1.1\r\nHost: example.com\r\n\r\n',
          );
        });
        let buf = '';
        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const endIdx = buf.indexOf('\r\n\r\n');
          if (endIdx !== -1) {
            const statusLine = buf.slice(0, buf.indexOf('\r\n'));
            const status = Number(statusLine.split(' ')[1]);
            const body = buf.slice(endIdx + 4);
            socket.destroy();
            resolve({ status, body });
          }
        });
        socket.on('error', reject);
      },
    );

    expect(response.status).toBe(400);
  });

  test('policyCallback can inject extra headers', async () => {
    const { upstreamUrl, proxyUrl } = await setupPair(
      async () => ({ 'X-Injected': 'policy-value' }),
    );

    const response = await proxyRequest(
      proxyUrl,
      `${upstreamUrl}/inject-test`,
      'GET',
    );

    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as EchoBody;
    expect(data.headers['x-injected']).toBe('policy-value');
  });

  test('policyCallback returning null rejects with 403', async () => {
    const { upstreamUrl, proxyUrl } = await setupPair(async () => null);

    const response = await proxyRequest(
      proxyUrl,
      `${upstreamUrl}/blocked`,
      'GET',
    );

    expect(response.status).toBe(403);
    expect(response.body).toBe('Forbidden');
  });

  test('policyCallback error returns 502', async () => {
    const { upstreamUrl, proxyUrl } = await setupPair(async () => {
      throw new Error('policy failure');
    });

    const response = await proxyRequest(
      proxyUrl,
      `${upstreamUrl}/error`,
      'GET',
    );

    expect(response.status).toBe(502);
    expect(response.body).toBe('Bad Gateway');
  });

  test('onRequest callback is called for HTTP requests', async () => {
    const upstream = createServer(async (req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const up = await listenEphemeral(upstream);
    servers.push(up);

    const requestLog: Array<{ method: string; url: string }> = [];
    const proxy = createProxyServer({
      onRequest: (method, url) => requestLog.push({ method, url }),
    });
    const px = await listenEphemeral(proxy);
    servers.push(px);

    await proxyRequest(px.url, `${up.url}/test`, 'GET');

    expect(requestLog).toHaveLength(1);
    expect(requestLog[0].method).toBe('GET');
    expect(requestLog[0].url).toContain('/test');
  });
});
