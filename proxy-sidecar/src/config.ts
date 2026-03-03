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
  /** Optional CA directory for MITM interception (contains ca.pem / ca-key.pem). */
  caDir: string | null;
  /** Log level for the sidecar process. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Parse and validate sidecar configuration from environment variables.
 *
 * Environment variables:
 *   PROXY_PORT            - Port to listen on (default: 8080)
 *   PROXY_HOST            - Host to bind to (default: "0.0.0.0")
 *   PROXY_CA_DIR          - Path to CA directory for MITM (optional)
 *   PROXY_LOG_LEVEL       - Log level: debug | info | warn | error (default: "info")
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): SidecarConfig {
  const port = parsePort(env.PROXY_PORT);
  const host = env.PROXY_HOST ?? '0.0.0.0';
  const caDir = env.PROXY_CA_DIR ?? null;
  const logLevel = parseLogLevel(env.PROXY_LOG_LEVEL);

  return { port, host, caDir, logLevel };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 8080;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `PROXY_PORT must be an integer between 1 and 65535, got "${raw}"`,
    );
  }
  return port;
}

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'] as const);
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw === '') return 'info';

  const lower = raw.toLowerCase();
  if (!VALID_LOG_LEVELS.has(lower as LogLevel)) {
    throw new ConfigError(
      `PROXY_LOG_LEVEL must be one of debug, info, warn, error — got "${raw}"`,
    );
  }
  return lower as LogLevel;
}

/**
 * Dedicated error class for configuration validation failures.
 * The entrypoint catches this to print a clean message without a stack trace.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
