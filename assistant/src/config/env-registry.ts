/**
 * Centralized environment variable registry.
 *
 * This module documents every VELLUM_* and related env var with its type,
 * default, and description, and exports typed accessor functions for each.
 *
 * IMPORTANT: This module has NO internal imports (no logger, no platform
 * utilities) so it can be safely imported from bootstrap-level code like
 * util/platform.ts and util/logger.ts without circular dependencies.
 *
 * Higher-level env vars that depend on the logger or config system live in
 * config/env.ts, which re-exports selected accessors from this module.
 */

// ── Helpers (dependency-free) ────────────────────────────────────────────────

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function flag(name: string): boolean {
  const raw = str(name);
  return raw === "true" || raw === "1";
}

function flagTriState(name: string): boolean | undefined {
  const raw = str(name);
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Each entry documents the env var name, type, default, and purpose.

/**
 * BASE_DATA_DIR — string, default: os.homedir()
 * Overrides the home directory used as the base for ~/.vellum and lockfiles.
 * Primarily used in tests to isolate filesystem state.
 */
export function getBaseDataDir(): string | undefined {
  return str("BASE_DATA_DIR");
}

/**
 * VELLUM_DAEMON_TCP_PORT — number, default: 8765
 * TCP port for the daemon's TCP listener (used by iOS clients).
 */
export function getDaemonTcpPort(): number {
  const raw = str("VELLUM_DAEMON_TCP_PORT");
  if (raw) {
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) return port;
  }
  return 8765;
}

/**
 * VELLUM_DAEMON_TCP_ENABLED — boolean tri-state, default: undefined (falls back to flag file)
 * Whether the daemon TCP listener should be active.
 * 'true'/'1' → on, 'false'/'0' → off, unset → check flag file.
 */
export function getDaemonTcpEnabled(): boolean | undefined {
  return flagTriState("VELLUM_DAEMON_TCP_ENABLED");
}

/**
 * VELLUM_DAEMON_TCP_HOST — string, default: context-dependent (127.0.0.1 or 0.0.0.0)
 * Hostname/address for the TCP listener. When unset, platform.ts resolves
 * based on whether iOS pairing is enabled.
 */
export function getDaemonTcpHost(): string | undefined {
  return str("VELLUM_DAEMON_TCP_HOST");
}

/**
 * VELLUM_DAEMON_IOS_PAIRING — boolean tri-state, default: undefined (falls back to flag file)
 * Whether iOS pairing mode is enabled. When on, TCP binds to 0.0.0.0.
 * 'true'/'1' → on, 'false'/'0' → off, unset → check flag file.
 */
export function getDaemonIosPairing(): boolean | undefined {
  return flagTriState("VELLUM_DAEMON_IOS_PAIRING");
}

/**
 * VELLUM_DEBUG — boolean, default: false
 * Enables debug-level logging and verbose output.
 */
export function getDebugMode(): boolean {
  return flag("VELLUM_DEBUG");
}

/**
 * VELLUM_LOG_STDERR — boolean, default: false
 * Forces logger output to stderr instead of log files.
 */
export function getLogStderr(): boolean {
  return flag("VELLUM_LOG_STDERR");
}

/**
 * DEBUG_STDOUT_LOGS — boolean, default: false
 * Enables additional log output to stdout (alongside file logging).
 */
export function getDebugStdoutLogs(): boolean {
  return flag("DEBUG_STDOUT_LOGS");
}

/**
 * VELLUM_ENABLE_MONITORING — boolean, default: false
 * Enables monitoring/telemetry (Logfire, etc.).
 */
export function getEnableMonitoring(): boolean {
  return flag("VELLUM_ENABLE_MONITORING");
}

/**
 * IS_CONTAINERIZED — boolean, default: false
 * When true, indicates the assistant is running inside a container (e.g. Docker).
 * Any new data that needs to survive restarts must be written to BASE_DATA_DIR,
 * which is mapped to a persistent volume.
 */
export function getIsContainerized(): boolean {
  return flag("IS_CONTAINERIZED");
}

// ── Known env var names ──────────────────────────────────────────────────────

/**
 * Complete set of recognized VELLUM_* env var names. Used by validateEnvVars()
 * to warn about typos or unrecognized variables.
 */
const KNOWN_VELLUM_VARS = new Set([
  "VELLUM_DAEMON_TCP_PORT",
  "VELLUM_DAEMON_TCP_ENABLED",
  "VELLUM_DAEMON_TCP_HOST",
  "VELLUM_DAEMON_IOS_PAIRING",
  "VELLUM_DAEMON_NOAUTH",
  "VELLUM_DAEMON_AUTOSTART",
  "VELLUM_DEBUG",
  "VELLUM_LOG_STDERR",
  "VELLUM_ENABLE_MONITORING",
  "VELLUM_HOOK_EVENT",
  "VELLUM_HOOK_NAME",
  "VELLUM_HOOK_SETTINGS",
  "VELLUM_ROOT_DIR",
  "VELLUM_WORKSPACE_DIR",
  "VELLUM_CLAUDE_CODE_DEPTH",
  "VELLUM_ASSISTANT_PLATFORM_URL",
  "VELLUM_UNSAFE_AUTH_BYPASS",
  "VELLUM_DATA_DIR",
]);

/**
 * Check all VELLUM_* env vars and return warnings for any unrecognized ones.
 * Returns an array of warning messages (empty if all vars are recognized).
 *
 * This is intentionally a pure function that returns strings rather than
 * logging directly, so it can be called from bootstrap code before the
 * logger is initialized.
 */
export function checkUnrecognizedEnvVars(): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VELLUM_") && !KNOWN_VELLUM_VARS.has(key)) {
      warnings.push(`Unrecognized environment variable: ${key}`);
    }
  }
  return warnings;
}
