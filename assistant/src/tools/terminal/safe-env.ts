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
  "VELLUM_SLOW_SYNC_THRESHOLD_MS",
  "VELLUM_DEVICE_ID",
  "VELLUM_DISABLE_PLATFORM",
  "VELLUM_ENVIRONMENT",

  "VELLUM_WORKSPACE_DIR",
  "CES_BOOTSTRAP_SOCKET_DIR",
  "GATEWAY_INTERNAL_URL",
  "ASSISTANT_IPC_SOCKET_DIR",
  "ASSISTANT_SKILL_IPC_SOCKET_DIR",
  "GATEWAY_IPC_SOCKET_DIR",
  "GATEWAY_SECURITY_DIR",
  "VELLUM_PLATFORM_URL",
  "VELLUM_ASSISTANT_PLATFORM_URL",
  "VELLUM_DOCS_BASE_URL",
  "VELLUM_MIGRATION_IMPORT_ALLOWED_HOSTS",
  "CES_CREDENTIAL_URL",
  "CES_MANAGED_MODE",
  "CES_STANDALONE",
  "CES_LOCAL_SOCKET",
  "IS_CONTAINERIZED",
  "IS_PLATFORM",
  "VELLUM_CLOUD",
  "VELLUM_SANDBOX_RUNTIME",
  "CES_SERVICE_TOKEN",
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
  "VELLUM_MEMORY_LIMIT",
  "VELLUM_CPU_LIMIT",
  "VELLUM_MINIKUBE_STORAGE_SIZE",
  "VELLUM_BACKUP_DIR",
  "VELLUM_BACKUP_KEY_PATH",
] as const;

export const KATA_SAFE_ENV_VARS = [
  "VELLUM_APT_DATA_ROOT",
  "VELLUM_APT_DATA_SUITE",
  "VELLUM_APT_DATA_MIRROR",
] as const;

export const KATA_INJECTED_ENV_VARS = ["LD_LIBRARY_PATH"] as const;

const KATA_APT_DATA_ROOT = "/data/system";
const KATA_FAMILY_SANDBOX_RUNTIMES = new Set([
  "kata",
  "firecracker",
  "cloud-hypervisor",
]);

function isKataFamilyRuntime(runtime: string | undefined): boolean {
  return runtime != null && KATA_FAMILY_SANDBOX_RUNTIMES.has(runtime);
}

function kataAptPaths(dataRoot: string): string[] {
  return [
    `${dataRoot}/bin`,
    `${dataRoot}/usr/local/sbin`,
    `${dataRoot}/usr/local/bin`,
    `${dataRoot}/usr/sbin`,
    `${dataRoot}/usr/bin`,
    `${dataRoot}/sbin`,
    `${dataRoot}/usr/games`,
    `${dataRoot}/games`,
  ];
}

function kataAptLibraryPaths(dataRoot: string): string[] {
  return [
    `${dataRoot}/usr/local/lib`,
    `${dataRoot}/usr/lib`,
    `${dataRoot}/usr/lib/x86_64-linux-gnu`,
    `${dataRoot}/usr/lib/aarch64-linux-gnu`,
  ];
}

/**
 * Keys that buildSanitizedEnv always injects into the returned env,
 * independent of what is present in process.env.
 */
export const ALWAYS_INJECTED_ENV_VARS = [
  "INTERNAL_GATEWAY_BASE_URL",
  "SPECIES",
  "VELLUM_DATA_DIR",
  "VELLUM_WORKSPACE_DIR",
] as const;

function appendUniquePathEntries(
  value: string | undefined,
  entries: readonly string[],
): string {
  const parts = value ? value.split(":").filter(Boolean) : [];
  for (const entry of entries) {
    if (!parts.includes(entry)) {
      parts.push(entry);
    }
  }
  return parts.join(":");
}

export function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const isKataRuntime = isKataFamilyRuntime(process.env.VELLUM_SANDBOX_RUNTIME);
  const safeEnvVars = isKataRuntime
    ? [...SAFE_ENV_VARS, ...KATA_SAFE_ENV_VARS]
    : SAFE_ENV_VARS;

  for (const key of safeEnvVars) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  if (isKataRuntime) {
    const kataAptDataRoot = env.VELLUM_APT_DATA_ROOT ?? KATA_APT_DATA_ROOT;
    env.VELLUM_APT_DATA_ROOT = kataAptDataRoot;
    env.PATH = appendUniquePathEntries(env.PATH, kataAptPaths(kataAptDataRoot));
    env.LD_LIBRARY_PATH = appendUniquePathEntries(
      undefined,
      kataAptLibraryPaths(kataAptDataRoot),
    );
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
  // Identify the assistant species so skill scripts can gate on species-specific
  // logic. Hardcoded to "vellum" — this is the Vellum assistant codebase.
  env.SPECIES = "vellum";
  // Ensure UTF-8 locale so multi-byte characters (em dashes, curly quotes,
  // arrows, etc.) survive piping through tools like pbcopy without corruption.
  // macOS (Darwin) does not provide C.UTF-8, so use en_US.UTF-8 there.
  const utf8Locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  if (!env.LANG) env.LANG = utf8Locale;
  if (!env.LC_ALL) env.LC_ALL = utf8Locale;
  return env;
}
