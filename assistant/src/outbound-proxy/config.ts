/**
 * Configuration for the standalone proxy sidecar server.
 *
 * All values are sourced from environment variables with sensible defaults.
 * Invalid values cause the process to exit with a descriptive error so
 * misconfigurations are caught immediately at startup.
 */

export interface SidecarConfig {
  /** Port the proxy server listens on. */
  port: number;
  /** Host address to bind to. */
  host: string;
  /** Port for the health/readiness HTTP server. */
  healthPort: number;
  /** Optional CA directory for MITM interception (contains ca.pem / ca-key.pem). */
  caDir: string | null;
  /** Log level for the sidecar process. */
  logLevel: "debug" | "info" | "warn" | "error";
}
