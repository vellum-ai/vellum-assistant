/**
 * Health / readiness HTTP server for the proxy sidecar.
 *
 * Exposes two endpoints on a separate control port:
 *   GET /healthz  - Liveness probe. Returns 200 whenever the process is alive.
 *   GET /readyz   - Readiness probe. Returns 200 only when the proxy server
 *                   is listening and ready to accept connections.
 *
 * All other paths return 404. Non-GET methods return 405.
 */

import { createServer, type Server } from "node:http";

export interface HealthServerOptions {
  /**
   * Callback that returns `true` when the proxy server is ready to accept
   * connections. The readiness probe delegates to this function.
   */
  isReady: () => boolean;
}

/**
 * Create an HTTP server that serves health and readiness endpoints.
 *
 * The returned server is not yet listening -- the caller is responsible for
 * calling `.listen()`.
 */
export function createHealthServer(options: HealthServerOptions): Server {
  const { isReady } = options;

  const server = createServer((req, res) => {
    // Only support GET requests
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET" });
      res.end("Method Not Allowed\n");
      return;
    }

    switch (req.url) {
      case "/healthz": {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      case "/readyz": {
        const ready = isReady();
        const statusCode = ready ? 200 : 503;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: ready ? "ready" : "not_ready" }));
        return;
      }

      default: {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found\n");
      }
    }
  });

  return server;
}
