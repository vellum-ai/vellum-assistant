/**
 * Structured CLI error reporting for upgrade/rollback commands.
 *
 * When a CLI command fails, it can emit a machine-readable JSON object
 * prefixed with `CLI_ERROR:` to stderr so that consumers (e.g. the
 * desktop app) can parse it reliably. Modeled after the DAEMON_ERROR
 * protocol in `assistant/src/daemon/startup-error.ts`.
 */

/** Known error categories emitted by CLI commands. */
export type CliErrorCategory =
  | "DOCKER_NOT_RUNNING"
  | "IMAGE_PULL_FAILED"
  | "MISSING_VERSION"
  | "READINESS_TIMEOUT"
  | "ROLLBACK_FAILED"
  | "ROLLBACK_NO_STATE"
  | "VERSION_DIRECTION"
  | "AUTH_FAILED"
  | "NETWORK_ERROR"
  | "UNSUPPORTED_TOPOLOGY"
  | "ASSISTANT_NOT_FOUND"
  | "PLATFORM_API_ERROR"
  | "UNKNOWN";

interface CliErrorPayload {
  error: CliErrorCategory;
  message: string;
  detail?: string;
}

const CLI_ERROR_PREFIX = "CLI_ERROR:";

/**
 * Write a structured error line to stderr. The line is prefixed with
 * `CLI_ERROR:` followed by JSON, making it unambiguous even if other
 * stderr output precedes it.
 */
export function emitCliError(
  category: CliErrorCategory,
  message: string,
  detail?: string,
): void {
  const payload: CliErrorPayload = { error: category, message, detail };
  const line = `${CLI_ERROR_PREFIX}${JSON.stringify(payload)}`;
  process.stderr.write(line + "\n");
}

/**
 * Inspect an error string and return the most appropriate
 * {@link CliErrorCategory} for common upgrade/rollback failures.
 */
export function categorizeUpgradeError(err: unknown): CliErrorCategory {
  const msg = String(err).toLowerCase();

  if (
    msg.includes("cannot connect to the docker") ||
    msg.includes("is docker running")
  ) {
    return "DOCKER_NOT_RUNNING";
  }

  if (
    msg.includes("manifest unknown") ||
    msg.includes("manifest not found") ||
    msg.includes("pull access denied") ||
    msg.includes("repository does not exist")
  ) {
    return "IMAGE_PULL_FAILED";
  }

  if (msg.includes("timeout") || msg.includes("readyz")) {
    return "READINESS_TIMEOUT";
  }

  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized")
  ) {
    return "AUTH_FAILED";
  }

  if (
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("network")
  ) {
    return "NETWORK_ERROR";
  }

  return "UNKNOWN";
}
