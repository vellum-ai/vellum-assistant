import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getBaseDataDir,
  getIsContainerized,
  getWorkspaceDirOverride,
} from "../config/env-registry.js";

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Returns the raw platform string from Node.js (e.g. 'darwin', 'linux', 'win32').
 * Prefer this over accessing process.platform directly so all platform
 * detection is routed through this module.
 */
export function getPlatformName(): string {
  return process.platform;
}

/**
 * Returns the platform-specific clipboard copy command, or null if
 * clipboard access is not supported on the current platform.
 */
export function getClipboardCommand(): string | null {
  if (isMacOS()) return "pbcopy";
  if (isLinux()) return "xclip -selection clipboard";
  return null;
}

/**
 * Read and parse the lockfile (~/.vellum.lock.json).
 * Respects BASE_DATA_DIR for non-standard home directories.
 * Returns null if the file doesn't exist or is malformed.
 */
export function readLockfile(): Record<string, unknown> | null {
  const base = getBaseDataDir() || homedir();
  const lockPath = join(base, ".vellum.lock.json");
  if (!existsSync(lockPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // malformed JSON
  }
  return null;
}

/**
 * Resolve the instance data directory from the lockfile.
 *
 * Checks both ~/.vellum.lock.json (current) and ~/.vellum.lockfile.json
 * (legacy) to support installs that haven't migrated the filename.
 *
 * Reads the lockfile from homedir() directly (NOT via readLockfile() which
 * depends on BASE_DATA_DIR) to avoid circular dependency — this function is
 * called at CLI bootstrap before BASE_DATA_DIR is set.
 *
 * Resolution:
 *   - If activeAssistant matches a local assistant, returns its instanceDir.
 *   - If there is exactly one local assistant and no activeAssistant, returns
 *     its instanceDir (auto-select).
 *   - Returns undefined in all other cases (no lockfile, no local assistants,
 *     multiple local assistants with no active selection, malformed JSON).
 *
 * Synchronous (uses readFileSync) since it runs at bootstrap before any async
 * context. Never throws — catches all errors and returns undefined for
 * graceful degradation.
 */
export function resolveInstanceDataDir(): string | undefined {
  try {
    const home = homedir();
    const candidates = [
      join(home, ".vellum.lock.json"),
      join(home, ".vellum.lockfile.json"),
    ];

    let raw: unknown;
    for (const lockPath of candidates) {
      if (!existsSync(lockPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(lockPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed;
          break;
        }
      } catch {
        // Malformed JSON; try next candidate
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const lockData = raw as Record<string, unknown>;

    const assistants = lockData.assistants as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(assistants)) return undefined;

    const localAssistants = assistants.filter(
      (a) => a.cloud === "local" || a.cloud === undefined,
    );
    if (localAssistants.length === 0) return undefined;

    const activeAssistant = lockData.activeAssistant as string | undefined;

    if (activeAssistant) {
      const match = localAssistants.find(
        (a) => a.assistantId === activeAssistant,
      );
      if (match) {
        const resources = match.resources as
          | Record<string, unknown>
          | undefined;
        return resources?.instanceDir as string | undefined;
      }
      return undefined;
    }

    if (localAssistants.length === 1) {
      const resources = localAssistants[0].resources as
        | Record<string, unknown>
        | undefined;
      return resources?.instanceDir as string | undefined;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize an assistant ID to its canonical form for DB operations.
 *
 * The system uses "self" as the canonical single-tenant identifier
 * (see migration 007-assistant-id-to-self). However, the desktop UI
 * sends the real assistant ID (e.g., "vellum-true-eel") while the
 * inbound call path resolves phone numbers to config keys (typically
 * "self"). This function maps any known lockfile assistant ID to "self"
 * so both sides use a consistent DB key.
 *
 * Multi-instance safety: each daemon process runs with a scoped
 * BASE_DATA_DIR, so readLockfile() only sees the lockfile for this
 * instance. The mapping to "self" is correct because each daemon is
 * single-tenant — it only manages its own instance's data.
 */
export function normalizeAssistantId(assistantId: string): string {
  if (assistantId === "self") return "self";

  try {
    const lockData = readLockfile();
    const assistants = lockData?.assistants as
      | Array<Record<string, unknown>>
      | undefined;
    if (assistants) {
      for (const entry of assistants) {
        if (entry.assistantId === assistantId) return "self";
      }
    }
  } catch {
    // lockfile unreadable — return as-is
  }

  return assistantId;
}

/**
 * Write data to the primary lockfile (~/.vellum.lock.json).
 * Respects BASE_DATA_DIR for non-standard home directories.
 */
export function writeLockfile(data: Record<string, unknown>): void {
  const base = getBaseDataDir() || homedir();
  writeFileSync(
    join(base, ".vellum.lock.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

/**
 * Returns the root ~/.vellum directory. User-facing files (config, prompt
 * files, skills) and runtime files (socket, PID) live here.
 */
export function getRootDir(): string {
  return join(getBaseDataDir() || homedir(), ".vellum");
}

/**
 * Returns the internal data directory (~/.vellum/workspace/data). Runtime
 * databases, logs, memory indices, and other internal state live here.
 */
export function getDataDir(): string {
  return join(getWorkspaceDir(), "data");
}

/**
 * Returns the embedding models directory (~/.vellum/workspace/embedding-models).
 * Downloaded embedding runtime (onnxruntime-node, transformers bundle, model weights)
 * is stored here, downloaded post-hatch rather than shipped with the app.
 */
export function getEmbeddingModelsDir(): string {
  return join(getWorkspaceDir(), "embedding-models");
}

/**
 * Returns the sandbox root directory (~/.vellum/data/sandbox).
 * Global sandbox state lives under this directory.
 */
export function getSandboxRootDir(): string {
  return join(getDataDir(), "sandbox");
}

/**
 * Returns the default sandbox working directory (~/.vellum/workspace).
 * This is the workspace root — tool working directories should use this
 * path unless explicitly overridden.
 */
export function getSandboxWorkingDir(): string {
  return getWorkspaceDir();
}

export function getInterfacesDir(): string {
  return join(getDataDir(), "interfaces");
}

/**
 * Returns the sounds directory (~/.vellum/workspace/data/sounds).
 * Custom sound files and sound configuration live here. Sound files
 * can be large, so this directory is excluded from diagnostic exports.
 */
export function getSoundsDir(): string {
  return join(getWorkspaceDir(), "data", "sounds");
}

/**
 * Returns the TCP port the daemon should listen on for iOS clients.
 * Hardcoded default: 8765.
 */
export function getTCPPort(): number {
  return 8765;
}

/**
 * Returns whether the daemon TCP listener should be enabled.
 * Checks for the presence of the flag file ~/.vellum/tcp-enabled.
 * Default: false.
 *
 * The flag-file check makes it easy to enable TCP in dev without restarting
 * the shell: `touch ~/.vellum/tcp-enabled && kill -USR1 <daemon-pid>`.
 */
export function isTCPEnabled(): boolean {
  return existsSync(join(getRootDir(), "tcp-enabled"));
}

/**
 * Returns the hostname/address for the TCP listener.
 * If iOS pairing is enabled (flag file): '0.0.0.0' (LAN-accessible).
 * Default: '127.0.0.1' (localhost only).
 */
export function getTCPHost(): string {
  if (isIOSPairingEnabled()) return "0.0.0.0";
  return "127.0.0.1";
}

/**
 * Returns whether iOS pairing mode is enabled.
 * When enabled, the TCP listener binds to 0.0.0.0 (all interfaces)
 * instead of 127.0.0.1 (localhost only), making the daemon reachable
 * from iOS devices on the same local network.
 *
 * Checks for the presence of the flag file ~/.vellum/ios-pairing-enabled.
 * Default: false.
 *
 * This is separate from isTCPEnabled() — TCP can be enabled for localhost-only
 * access without exposing the daemon to the LAN.
 */
export function isIOSPairingEnabled(): boolean {
  return existsSync(join(getRootDir(), "ios-pairing-enabled"));
}

/**
 * Returns the XDG-compliant path for the platform API token
 * (~/.config/vellum/platform-token). This is the canonical location
 * shared by the CLI and desktop app.
 */
function getXdgPlatformTokenPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "vellum", "platform-token");
}

/**
 * Returns the instance-scoped path to the platform API token file
 * (~/.vellum/platform-token). Used as a fallback for local assistant
 * instances that may have the token written here by the desktop app.
 */
export function getPlatformTokenPath(): string {
  return join(getRootDir(), "platform-token");
}

/**
 * Read the platform API token from disk. Checks the instance-scoped
 * path first, then falls back to the XDG-compliant shared location.
 * Returns null if neither file exists or can be read.
 */
export function readPlatformToken(): string | null {
  try {
    return readFileSync(getPlatformTokenPath(), "utf-8").trim();
  } catch {
    // Instance-scoped token not found; try XDG path
  }
  try {
    return readFileSync(getXdgPlatformTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

export function getPidPath(): string {
  return join(getRootDir(), "vellum.pid");
}

export function getDbPath(): string {
  return join(getDataDir(), "db", "assistant.db");
}

export function getLogPath(): string {
  return join(getDataDir(), "logs", "vellum.log");
}

export function getHistoryPath(): string {
  return join(getDataDir(), "history");
}

export function getHooksDir(): string {
  return join(getRootDir(), "hooks");
}

/**
 * Returns ~/.vellum/signals — the directory for IPC signal files.
 *
 * Placed under getRootDir() (not getWorkspaceDir()) so that sandboxed tools
 * — whose write access is limited to the workspace directory — cannot write
 * signal files to bypass guardian authorization.
 */
export function getSignalsDir(): string {
  return join(getRootDir(), "signals");
}
// --- Workspace path primitives ---
// These will become the canonical paths after workspace migration.
// Currently not used by call-sites; wired in later PRs.

/**
 * Returns the workspace root for user-facing state.
 *
 * When the WORKSPACE_DIR env var is set, returns that value (used in
 * containerized deployments where the workspace is a separate volume).
 * Otherwise falls back to ~/.vellum/workspace.
 *
 * WARNING: The entire workspace directory is included in diagnostic log exports
 * ("Send logs to Vellum"). Do not store secrets, API keys, or sensitive
 * credentials here — use the credential store or ~/.vellum/protected/ instead.
 */
export function getWorkspaceDir(): string {
  const override = getWorkspaceDirOverride();
  if (override) return override;
  return join(getRootDir(), "workspace");
}

/**
 * Returns a display-friendly workspace path for embedding in agent-facing text
 * (skill bodies, tool descriptions). Replaces the home directory prefix with `~`
 * so paths stay concise and portable across machines.
 *
 * Examples:
 *   /Users/sidd/.vellum/workspace → ~/.vellum/workspace
 *   /data/.vellum/workspace       → /data/.vellum/workspace
 */
export function getWorkspaceDirDisplay(): string {
  const abs = getWorkspaceDir();
  const home = homedir();
  if (abs.startsWith(home + "/") || abs === home) {
    return "~" + abs.slice(home.length);
  }
  return abs;
}

/** Returns ~/.vellum/workspace/config.json */
export function getWorkspaceConfigPath(): string {
  return join(getWorkspaceDir(), "config.json");
}

/** Returns ~/.vellum/workspace/skills */
export function getWorkspaceSkillsDir(): string {
  return join(getWorkspaceDir(), "skills");
}

/** Returns ~/.vellum/workspace/hooks */
export function getWorkspaceHooksDir(): string {
  return join(getWorkspaceDir(), "hooks");
}

/** Returns ~/.vellum/workspace/conversations */
export function getConversationsDir(): string {
  return join(getWorkspaceDir(), "conversations");
}

/** Returns the workspace path for a prompt file (e.g. IDENTITY.md, SOUL.md, USER.md). */
export function getWorkspacePromptPath(file: string): string {
  return join(getWorkspaceDir(), file);
}

export function ensureDataDir(): void {
  const root = getRootDir();
  const workspace = getWorkspaceDir();
  const wsData = join(workspace, "data");
  const containerized = getIsContainerized();
  const dirs = [
    // Root-level dirs (runtime)
    root,
    // protected, signals, hooks are local-only — skip in containerized mode
    // (credentials via CES HTTP API, trust via gateway API, no IPC signals)
    ...(containerized
      ? []
      : [join(root, "protected"), join(root, "signals"), join(root, "hooks")]),
    // Workspace dirs
    workspace,
    join(workspace, "skills"),
    join(workspace, "embedding-models"),
    join(workspace, "conversations"),
    // Data sub-dirs under workspace
    wsData,
    join(wsData, "db"),
    join(wsData, "qdrant"),
    join(wsData, "logs"),
    join(wsData, "memory"),
    join(wsData, "memory", "knowledge"),
    join(wsData, "apps"),
    join(wsData, "interfaces"),
    join(wsData, "sounds"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  // Lock down the root directory so only the owner can traverse it.
  // Runtime files (socket, session token, PID) live directly under root.
  try {
    chmodSync(root, 0o700);
  } catch {
    // Non-fatal: some filesystems don't support Unix permissions
  }
}
