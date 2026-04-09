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

function int(name: string): number | undefined {
  const raw = str(name);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
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
 * IS_PLATFORM — boolean, default: false
 * When true, indicates the assistant is running as a platform-managed
 * remote instance. Controls platform-specific behaviors like webhook
 * callback registration and blocking `platform disconnect`.
 *
 * Separate from IS_CONTAINERIZED because local Docker assistants are
 * containerized (need CES sidecar, gateway trust store, etc.) but are
 * not platform-managed.
 */
export function getIsPlatform(): boolean {
  return flag("IS_PLATFORM");
}

/**
 * Whether this assistant is running as a platform-managed remote instance.
 */
export function isPlatformRemote(): boolean {
  return getIsPlatform();
}

/**
 * VELLUM_WORKSPACE_DIR — string, default: undefined
 * Overrides the default workspace directory.
 * Used in containerized deployments where the workspace is a separate volume.
 */
export function getWorkspaceDirOverride(): string | undefined {
  return str("VELLUM_WORKSPACE_DIR");
}

// ── Profiler env vars ───────────────────────────────────────────────────
// These are injected by the platform when running a managed assistant in
// profiler mode. The runtime uses them to locate, scope, and budget-limit
// profiler output on the workspace volume.

/**
 * VELLUM_CPU_LIMIT — string (K8s resource format), default: undefined
 * The CPU resource limit for the container (e.g. "2000m", "2").
 * Set by the platform StatefulSet template to the exact K8s CPU limit.
 * Used by the health endpoint to report accurate CPU core count inside
 * gVisor sandboxes where cgroup files may expose the host node's CPUs.
 */
export function getCpuLimit(): string | undefined {
  return str("VELLUM_CPU_LIMIT");
}

/**
 * VELLUM_PROFILER_RUN_ID — string, default: undefined
 * Unique identifier for the current profiler run. When set, the profiler
 * run store treats this run as "active" and will never prune its directory.
 */
export function getProfilerRunId(): string | undefined {
  return str("VELLUM_PROFILER_RUN_ID");
}

/**
 * VELLUM_PROFILER_MODE — string, default: undefined
 * The profiling mode to activate (e.g. "cpu", "heap", "cpu+heap").
 * When unset, profiling is disabled.
 */
export function getProfilerMode(): string | undefined {
  return str("VELLUM_PROFILER_MODE");
}

/**
 * VELLUM_PROFILER_MAX_BYTES — integer, default: undefined
 * Maximum total bytes retained across all profiler runs (including active).
 * The startup sweep prunes oldest completed runs to stay within budget.
 */
export function getProfilerMaxBytes(): number | undefined {
  return int("VELLUM_PROFILER_MAX_BYTES");
}

/**
 * VELLUM_PROFILER_MAX_RUNS — integer, default: undefined
 * Maximum number of completed profiler runs retained on disk.
 * The startup sweep prunes oldest completed runs to stay within budget.
 */
export function getProfilerMaxRuns(): number | undefined {
  return int("VELLUM_PROFILER_MAX_RUNS");
}

/**
 * VELLUM_PROFILER_MIN_FREE_MB — integer, default: undefined
 * Minimum free disk space (in megabytes) that must remain after profiler
 * runs are accounted for. The startup sweep prunes oldest completed runs
 * until at least this much free space is available.
 */
export function getProfilerMinFreeMb(): number | undefined {
  return int("VELLUM_PROFILER_MIN_FREE_MB");
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
  "VELLUM_DOCS_BASE_URL",
  "VELLUM_ENABLE_INSECURE_LAN_PAIRING",
  "VELLUM_HATCHED_BY",
  "VELLUM_HOOK_EVENT",
  "VELLUM_HOOK_NAME",
  "VELLUM_HOOK_SETTINGS",
  "VELLUM_LOCKFILE_DIR",
  "VELLUM_PLATFORM_URL",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_ROOT_DIR",
  "VELLUM_SSH_USER",
  "VELLUM_UNSAFE_AUTH_BYPASS",
  "VELLUM_WORKSPACE_DIR",
  "VELLUM_CPU_LIMIT",
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
