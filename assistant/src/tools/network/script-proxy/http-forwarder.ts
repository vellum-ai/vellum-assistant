/**
 * HTTP proxy forwarder — parses absolute-URL proxy requests and forwards
 * them to the upstream server with full body streaming.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

/** Hop-by-hop headers that MUST NOT be forwarded between proxy hops. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Optional callback for credential injection or policy gating.
 * Called before the upstream request is sent. Returns extra headers
 * to merge, or null to reject the request.
 */
export type PolicyCallback = (
  hostname: string,
  path: string,
) => Promise<Record<string, string> | null>;

/**
 * Strip hop-by-hop headers from an incoming header set.
 */
function filterHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * Forward a plain HTTP proxy request (absolute-URL form) to the upstream
 * server and stream the response back to the client.
 */
export function forwardHttpRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  policyCallback?: PolicyCallback,
): void {
  const urlStr = clientReq.url;
  if (!urlStr) {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
    clientRes.end('Bad Request');
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
    clientRes.end('Bad Request');
    return;
  }

  if (parsed.protocol !== 'http:') {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
    clientRes.end('Only HTTP is supported for non-CONNECT proxy requests');
    return;
  }

  const hostname = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 80;
  const path = parsed.pathname + parsed.search;

  const doForward = (extraHeaders: Record<string, string> = {}) => {
    const headers = { ...filterHeaders(clientReq.headers), ...extraHeaders };
    // Ensure Host header matches the upstream target
    headers['host'] = parsed.host;

    const upstreamReq = httpRequest(
      {
        hostname,
        port,
        path,
        method: clientReq.method,
        headers,
      },
      (upstreamRes: IncomingMessage) => {
        const responseHeaders = filterHeaders(upstreamRes.headers);
        clientRes.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(clientRes);
      },
    );

    upstreamReq.on('error', () => {
      // Don't leak internal error details — generic 502
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      clientRes.end('Bad Gateway');
    });

    // Stream client body to upstream
    clientReq.pipe(upstreamReq);
  };

  if (policyCallback) {
    policyCallback(hostname, path)
      .then((extraHeaders) => {
        if (extraHeaders === null) {
          clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
          clientRes.end('Forbidden');
          return;
        }
        doForward(extraHeaders);
      })
      .catch(() => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        clientRes.end('Bad Gateway');
      });
  } else {
    doForward();
  }
}
