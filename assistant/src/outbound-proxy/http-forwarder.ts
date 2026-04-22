/**
 * HTTP proxy forwarder -- parses absolute-URL proxy requests and forwards
 * them to the upstream server with full body streaming.
 */

import {
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";

/** Hop-by-hop headers that MUST NOT be forwarded between proxy hops. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Optional callback for credential injection or policy gating.
 * Called before the upstream request is sent. Returns extra headers
 * to merge, or null to reject the request.
 *
 * `method` and `requestHeaders` are populated for plain-HTTP proxied
 * requests (absolute-URL form). For HTTPS CONNECT tunnels the proxy has
 * not yet terminated TLS and cannot see HTTP-level details, so these are
 * left undefined.
 */
export type PolicyCallback = (
  hostname: string,
  port: number | null,
  path: string,
  scheme: "http" | "https",
  method?: string,
  requestHeaders?: IncomingMessage["headers"],
) => Promise<Record<string, string> | null>;

/**
 * Strip hop-by-hop headers and Connection-token headers (RFC 7230 s6.1)
 * from an incoming header set, preserving multi-value arrays.
 */
function filterHeaders(
  raw: IncomingMessage["headers"],
): Record<string, string | string[]> {
  // Collect extra headers listed in the Connection header (RFC 7230 s6.1)
  const connectionTokens = new Set<string>();
  const connValue = raw["connection"];
  if (connValue) {
    const values = Array.isArray(connValue) ? connValue : [connValue];
    for (const v of values) {
      for (const token of v.split(",")) {
        connectionTokens.add(token.trim().toLowerCase());
      }
    }
  }

  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (connectionTokens.has(lower)) continue;
    if (value === undefined) continue;
    out[key] = value;
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
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Bad Request");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Bad Request");
    return;
  }

  if (parsed.protocol !== "http:") {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Only HTTP is supported for non-CONNECT proxy requests");
    return;
  }

  const hostname = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 80;
  const path = parsed.pathname + parsed.search;

  const doForward = (extraHeaders: Record<string, string> = {}) => {
    const headers = { ...filterHeaders(clientReq.headers), ...extraHeaders };
    // Ensure Host header matches the upstream target
    headers["host"] = parsed.host;

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
        upstreamRes.on("error", () => {
          clientRes.destroy();
        });
        upstreamRes.pipe(clientRes);
      },
    );

    upstreamReq.on("error", () => {
      // Don't leak internal error details -- generic 502
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
      }
      clientRes.end("Bad Gateway");
    });

    // Stream client body to upstream
    clientReq.pipe(upstreamReq);
  };

  if (policyCallback) {
    policyCallback(
      hostname,
      parsed.port ? Number(parsed.port) : null,
      path,
      "http",
      clientReq.method,
      clientReq.headers,
    )
      .then((extraHeaders) => {
        if (extraHeaders == null) {
          clientRes.writeHead(403, { "Content-Type": "text/plain" });
          clientRes.end("Forbidden");
          return;
        }
        doForward(extraHeaders);
      })
      .catch(() => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "Content-Type": "text/plain" });
        }
        clientRes.end("Bad Gateway");
      });
  } else {
    doForward();
  }
}
