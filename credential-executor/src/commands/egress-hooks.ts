/**
 * CES egress proxy hooks.
 *
 * Provides a lightweight `SessionStartHooks` implementation for the
 * credential execution service. Unlike the assistant's session-manager
 * (which wires credential resolution, MITM interception, and policy
 * decisions), CES only needs to enforce the manifest's
 * `allowedNetworkTargets` allowlist. No credential injection or CA
 * setup happens at the proxy layer — CES injects credentials through
 * auth adapters in the command environment.
 *
 * The proxy server is a plain HTTP CONNECT proxy that:
 * - Allows connections to hosts matching the session's `allowedTargets`
 * - Blocks all other outbound connections
 */

import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";

import type { ManagedSession, SessionStartHooks } from "@vellumai/egress-proxy";

// ---------------------------------------------------------------------------
// Host-pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a hostname against a glob pattern.
 *
 * Supported patterns:
 * - Exact match: `"api.github.com"` matches `"api.github.com"`
 * - Wildcard subdomain: `"*.github.com"` matches `"api.github.com"`,
 *   `"foo.bar.github.com"`, and also `"github.com"` (apex)
 * - Plain `"*"` matches everything
 */
function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === hostname) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // e.g. ".github.com"
    const apex = pattern.slice(2);   // e.g. "github.com"
    return hostname.endsWith(suffix) || hostname === apex;
  }
  return false;
}

/**
 * Check if a hostname is allowed by any of the provided patterns.
 */
function isHostAllowed(hostname: string, allowedTargets: string[]): boolean {
  for (const pattern of allowedTargets) {
    if (matchesHostPattern(hostname, pattern)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CONNECT tunnel handler
// ---------------------------------------------------------------------------

/**
 * Parse a CONNECT target of the form `host:port`.
 */
function parseConnectTarget(
  url: string | undefined,
): { host: string; port: number } | null {
  if (!url) return null;
  const colonIdx = url.lastIndexOf(":");
  if (colonIdx <= 0) return null;
  let host = url.slice(0, colonIdx);
  const portStr = url.slice(colonIdx + 1);
  if (!host || !portStr) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (!host) return null;
  }
  return { host, port };
}

// ---------------------------------------------------------------------------
// Hooks factory
// ---------------------------------------------------------------------------

/**
 * Build `SessionStartHooks` for CES egress enforcement.
 *
 * The created proxy server enforces the `allowedTargets` from the
 * session's config. If no `allowedTargets` are configured, all
 * connections are blocked (fail-closed).
 */
export function buildCesEgressHooks(): SessionStartHooks {
  return {
    // No CA setup needed — CES does not do MITM interception
    createServer: async (managed: ManagedSession) => {
      const allowedTargets = managed.config.allowedTargets ?? [];

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Plain HTTP proxy requests — parse the absolute URL and check the host
        if (req.url && req.method) {
          try {
            const target = new URL(req.url);
            if (!isHostAllowed(target.hostname, allowedTargets)) {
              res.writeHead(403, { "Content-Type": "text/plain" });
              res.end(`Blocked by CES egress policy: ${target.hostname} is not in the allowed targets list`);
              return;
            }

            // Forward the request using the appropriate protocol
            const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
            const proxyReq = doRequest(
              req.url,
              {
                method: req.method,
                headers: { ...req.headers, host: target.host },
              },
              (proxyRes) => {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                proxyRes.pipe(res);
              },
            );

            proxyReq.on("error", () => {
              if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain" });
              }
              res.end("Proxy connection error");
            });

            req.pipe(proxyReq);
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad request");
          }
          return;
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad request");
      });

      // Handle CONNECT for HTTPS tunnelling
      server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        const target = parseConnectTarget(req.url);
        if (!target) {
          clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          clientSocket.destroy();
          return;
        }

        if (!isHostAllowed(target.host, allowedTargets)) {
          clientSocket.write(
            "HTTP/1.1 403 Forbidden\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            `Blocked by CES egress policy: ${target.host} is not in the allowed targets list`,
          );
          clientSocket.destroy();
          return;
        }

        // Tunnel to the allowed target
        const upstream = connect(target.port, target.host, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstream.write(head);
          }
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });

        upstream.on("error", () => {
          clientSocket.destroy();
        });

        clientSocket.on("error", () => {
          upstream.destroy();
        });
      });

      return server;
    },
  };
}
