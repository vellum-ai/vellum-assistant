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

export interface HealthServerOptions {
  /**
   * Callback that returns `true` when the proxy server is ready to accept
   * connections. The readiness probe delegates to this function.
   */
  isReady: () => boolean;
}
