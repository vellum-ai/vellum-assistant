/**
 * Environment variables that are safe to pass through to child processes.
 * Everything else (API keys, tokens, credentials) is stripped to prevent
 * accidental leakage via agent-spawned commands.
 *
 * Shared by the sandbox bash tool and skill sandbox runner.
 */
import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { getDataDir, getWorkspaceDir } from "../../util/platform.js";

export const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "TERM",
  "LANG",
  "EDITOR",
  "SHELL",
  "USER",
  "TMPDIR",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "COLORTERM",
  "TERM_PROGRAM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  "GNUPGHOME",
  "VELLUM_DEV",
  "VELLUM_DEBUG",
  "VELLUM_ENVIRONMENT",
  "VELLUM_WORKSPACE_DIR",
  "VELLUM_WORKSPACE_VOLUME_NAME",
  "CES_BOOTSTRAP_SOCKET_DIR",
  "GATEWAY_INTERNAL_URL",
  "VELLUM_PLATFORM_URL",
  "VELLUM_ASSISTANT_PLATFORM_URL",
  "VELLUM_DOCS_BASE_URL",
  "CES_CREDENTIAL_URL",
  "CES_MANAGED_MODE",
  "IS_CONTAINERIZED",
  "IS_PLATFORM",
  "CES_SERVICE_TOKEN",
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
  "VELLUM_MEMORY_LIMIT",
  "VELLUM_CPU_LIMIT",
  "VELLUM_BACKUP_DIR",
  "VELLUM_BACKUP_KEY_PATH",
] as const;

/**
 * Keys that buildSanitizedEnv always injects into the returned env,
 * independent of what is present in process.env.
 */
export const ALWAYS_INJECTED_ENV_VARS = [
  "INTERNAL_GATEWAY_BASE_URL",
  "VELLUM_DATA_DIR",
  "VELLUM_WORKSPACE_DIR",
] as const;

export function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  // Always inject an internal gateway base for local control-plane/API calls.
  const internalGatewayBase = getGatewayInternalBaseUrl();
  env.INTERNAL_GATEWAY_BASE_URL = internalGatewayBase;
  // @deprecated — VELLUM_DATA_DIR is equivalent to $VELLUM_WORKSPACE_DIR/data.
  // Removing this requires an LLM-based migration or declarative migration
  // file to update existing user-authored skills to use VELLUM_WORKSPACE_DIR.
  env.VELLUM_DATA_DIR = getDataDir();
  // Expose the workspace directory so skills and child processes can read/write
  // workspace-scoped files (e.g. avatar traits, user data).
  env.VELLUM_WORKSPACE_DIR = getWorkspaceDir();
  // Ensure UTF-8 locale so multi-byte characters (em dashes, curly quotes,
  // arrows, etc.) survive piping through tools like pbcopy without corruption.
  // macOS (Darwin) does not provide C.UTF-8, so use en_US.UTF-8 there.
  const utf8Locale =
    process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  if (!env.LANG) env.LANG = utf8Locale;
  if (!env.LC_ALL) env.LC_ALL = utf8Locale;
  return env;
}
