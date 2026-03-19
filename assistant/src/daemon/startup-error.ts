/**
 * Structured startup error reporting for daemon processes.
 *
 * When the daemon fails to start, the last line of stderr contains a
 * machine-readable JSON object prefixed with `DAEMON_ERROR:` so that
 * consumers (e.g. the macOS app) can parse it reliably.
 */

/** Known error categories emitted on startup failure. */
export type DaemonErrorCategory =
  | "MIGRATION_FAILED"
  | "PORT_IN_USE"
  | "DB_LOCKED"
  | "DB_CORRUPT"
  | "ENV_VALIDATION"
  | "UNKNOWN";

export interface DaemonStartupError {
  error: DaemonErrorCategory;
  message: string;
  detail: string;
}

const DAEMON_ERROR_PREFIX = "DAEMON_ERROR:";

/**
 * Inspect an error and return a categorized {@link DaemonStartupError}.
 */
export function categorizeDaemonError(err: unknown): DaemonStartupError {
  if (err == null) {
    return {
      error: "UNKNOWN",
      message: String(err),
      detail: "An unexpected error occurred during startup.",
    };
  }

  const code = (err as { code?: string }).code ?? "";
  const name = (err as { name?: string }).name ?? "";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);

  // SQLite constraint errors during startup are almost always migration failures
  // (e.g. UNIQUE constraint violations when a migration re-runs).
  if (
    code.startsWith("SQLITE_CONSTRAINT") ||
    (name === "SQLiteError" && message.includes("UNIQUE constraint"))
  ) {
    return {
      error: "MIGRATION_FAILED",
      message: message,
      detail:
        "A database migration failed due to a constraint violation during startup.",
    };
  }

  // Generic migration detection: if the error message mentions "migration"
  // alongside SQLite, categorize as MIGRATION_FAILED.
  if (name === "SQLiteError" && /migration/i.test(message)) {
    return {
      error: "MIGRATION_FAILED",
      message: message,
      detail: "A database migration failed during startup.",
    };
  }

  // Port already in use
  if (code === "EADDRINUSE") {
    return {
      error: "PORT_IN_USE",
      message: message,
      detail:
        "The required port is already in use. Check if another assistant is already running.",
    };
  }

  // Database locked (another process holds the lock)
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return {
      error: "DB_LOCKED",
      message: message,
      detail:
        "The database is locked by another process. Check if another assistant is already running.",
    };
  }

  // Database corruption
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) {
    return {
      error: "DB_CORRUPT",
      message: message,
      detail:
        "The database appears to be corrupt. You may need to delete and recreate it.",
    };
  }

  // Environment validation errors thrown by validateEnv() or its int() helper
  if (
    message.startsWith("Invalid GATEWAY_PORT") ||
    message.startsWith("Invalid RUNTIME_HTTP_PORT") ||
    message.startsWith("Invalid integer for GATEWAY_PORT") ||
    message.startsWith("Invalid integer for RUNTIME_HTTP_PORT") ||
    message.startsWith("Invalid integer for QDRANT_HTTP_PORT") ||
    /\benv\b.*\bvalidat/i.test(message) ||
    /\bvalidat.*\benv\b/i.test(message)
  ) {
    return {
      error: "ENV_VALIDATION",
      message: message,
      detail: "Environment variable validation failed during startup.",
    };
  }

  // Fallback for uncategorized errors
  return {
    error: "UNKNOWN",
    message: message,
    detail: "An unexpected error occurred during startup.",
  };
}

/**
 * Write a structured error line to stderr. The line is prefixed with
 * `DAEMON_ERROR:` followed by JSON, making it unambiguous even if other
 * stderr output precedes it.
 */
export function emitDaemonError(err: unknown): void {
  const structured = categorizeDaemonError(err);
  const line = `${DAEMON_ERROR_PREFIX}${JSON.stringify(structured)}`;
  process.stderr.write(line + "\n");
}
