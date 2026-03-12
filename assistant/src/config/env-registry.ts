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
 * DEBUG_STDOUT_LOGS — boolean, default: false
 * Enables additional log output to stdout (alongside file logging).
 */
export function getDebugStdoutLogs(): boolean {
  return flag("DEBUG_STDOUT_LOGS");
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
  "VELLUM_ASSISTANT_NAME",
  "VELLUM_AWS_ROLE_ARN",
  "VELLUM_CLAUDE_CODE_DEPTH",
  "VELLUM_CUSTOM_QR_CODE_PATH",
  "VELLUM_DAEMON_AUTOSTART",
  "VELLUM_DAEMON_NOAUTH",
  "VELLUM_DATA_DIR",
  "VELLUM_DESKTOP_APP",
  "VELLUM_DEV",
  "VELLUM_ENABLE_INSECURE_LAN_PAIRING",
  "VELLUM_HATCHED_BY",
  "VELLUM_HOOK_EVENT",
  "VELLUM_HOOK_NAME",
  "VELLUM_HOOK_SETTINGS",
  "VELLUM_LOCKFILE_DIR",
  "VELLUM_PLATFORM_URL",
  "VELLUM_ROOT_DIR",
  "VELLUM_SSH_USER",
  "VELLUM_UNSAFE_AUTH_BYPASS",
  "VELLUM_WORKSPACE_DIR",
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
