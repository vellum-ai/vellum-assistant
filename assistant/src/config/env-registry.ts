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
 * DEBUG_STDOUT_LOGS — boolean, default: false
 * Enables additional log output to stdout (alongside file logging).
 */
export function getDebugStdoutLogs(): boolean {
  return flag("DEBUG_STDOUT_LOGS");
}

/**
 * IS_CONTAINERIZED — boolean, default: false
 * When true, indicates the assistant is running inside a container (e.g. Docker).
 * Persistent data is stored in VELLUM_WORKSPACE_DIR (mapped to a dedicated volume).
 */
export function getIsContainerized(): boolean {
  return flag("IS_CONTAINERIZED");
}

/**
 * VELLUM_CLOUD — string, default: undefined
 * Indicates the deployment mode: "docker" for CLI Docker, "local" for bare-metal.
 * Used to detect Docker networking topology independently of IS_CONTAINERIZED.
 */
export function getVellumCloud(): string | undefined {
  return str("VELLUM_CLOUD");
}

/**
 * Whether the assistant is running behind Docker networking (bridge/overlay).
 *
 * True when either:
 * - IS_CONTAINERIZED=true (platform-managed container), or
 * - VELLUM_CLOUD=docker (CLI-launched Docker — sets IS_CONTAINERIZED=false
 *   but the gateway still connects over the Docker bridge network).
 *
 * Use this instead of getIsContainerized() when the concern is network
 * topology (e.g. "should we accept private-network peers?") rather than
 * platform-managed behavior.
 */
export function getIsDockerNetworked(): boolean {
  return getIsContainerized() || getVellumCloud() === "docker";
}

/**
 * Whether this assistant is running as a platform-managed remote instance.
 *
 * Currently this is determined solely by the IS_CONTAINERIZED env var, which
 * the platform sets when provisioning assistant containers. This is not ideal
 * because any Docker environment could set it. We plan to replace this with a
 * less spoof-able mechanism in the future — e.g. a signed platform token
 * verified via asymmetric cryptography or an authenticated attestation
 * endpoint on the platform.
 */
export function isPlatformRemote(): boolean {
  return getIsContainerized();
}

/**
 * VELLUM_WORKSPACE_DIR — string, default: undefined
 * Overrides the default workspace directory.
 * Used in containerized deployments where the workspace is a separate volume.
 */
export function getWorkspaceDirOverride(): string | undefined {
  return str("VELLUM_WORKSPACE_DIR");
}

// ── Known env var names ──────────────────────────────────────────────────────

/**
 * Complete set of recognized VELLUM_* env var names. Used by validateEnvVars()
 * to warn about typos or unrecognized variables.
 */
const KNOWN_VELLUM_VARS = new Set([
  "VELLUM_ASSISTANT_NAME",
  "VELLUM_AWS_ROLE_ARN",
  "VELLUM_CLOUD",
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
