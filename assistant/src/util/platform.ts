import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getBaseDataDir,
  getDaemonIosPairing,
  getDaemonSocket,
  getDaemonTcpEnabled,
  getDaemonTcpHost,
  getDaemonTcpPort,
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
 * Returns the IPC blob directory (~/.vellum/workspace/data/ipc-blobs).
 * Temporary blob files for zero-copy IPC payloads live here.
 */
export function getIpcBlobDir(): string {
  return join(getDataDir(), "ipc-blobs");
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

export function getSocketPath(): string {
  const override = getDaemonSocket();
  if (override) {
    return expandHomePath(override);
  }
  return join(getRootDir(), "vellum.sock");
}

export function getSessionTokenPath(): string {
  return join(getRootDir(), "session-token");
}

/**
 * Returns the TCP port the daemon should listen on for iOS clients.
 * Reads VELLUM_DAEMON_TCP_PORT env var; defaults to 8765.
 */
export function getTCPPort(): number {
  return getDaemonTcpPort();
}

/**
 * Returns whether the daemon TCP listener should be enabled.
 * Resolution order (first match wins):
 *   1. VELLUM_DAEMON_TCP_ENABLED env var ('true'/'1' → on, 'false'/'0' → off)
 *   2. Presence of the flag file ~/.vellum/tcp-enabled (exists → on)
 *   3. Default: false
 *
 * The flag-file check makes it easy to enable TCP in dev without restarting
 * the shell: `touch ~/.vellum/tcp-enabled && kill -USR1 <daemon-pid>`.
 * The macOS CLI (AssistantCli) also sets the env var for bundled-binary deployments.
 */
export function isTCPEnabled(): boolean {
  const envValue = getDaemonTcpEnabled();
  if (envValue !== undefined) return envValue;
  return existsSync(join(getRootDir(), "tcp-enabled"));
}

/**
 * Returns the hostname/address for the TCP listener.
 * Resolution order (first match wins):
 *   1. VELLUM_DAEMON_TCP_HOST env var (explicit override)
 *   2. If iOS pairing is enabled: '0.0.0.0' (LAN-accessible)
 *   3. Default: '127.0.0.1' (localhost only)
 */
export function getTCPHost(): string {
  const override = getDaemonTcpHost();
  if (override) return override;
  if (isIOSPairingEnabled()) return "0.0.0.0";
  return "127.0.0.1";
}

/**
 * Returns whether iOS pairing mode is enabled.
 * When enabled, the TCP listener binds to 0.0.0.0 (all interfaces)
 * instead of 127.0.0.1 (localhost only), making the daemon reachable
 * from iOS devices on the same local network.
 *
 * Resolution order (first match wins):
 *   1. VELLUM_DAEMON_IOS_PAIRING env var ('true'/'1' → on, 'false'/'0' → off)
 *   2. Presence of the flag file ~/.vellum/ios-pairing-enabled (exists → on)
 *   3. Default: false
 *
 * This is separate from isTCPEnabled() — TCP can be enabled for localhost-only
 * access without exposing the daemon to the LAN.
 */
export function isIOSPairingEnabled(): boolean {
  const envValue = getDaemonIosPairing();
  if (envValue !== undefined) return envValue;
  return existsSync(join(getRootDir(), "ios-pairing-enabled"));
}

/**
 * Returns the path to the platform API token file (~/.vellum/platform-token).
 * This token is the X-Session-Token used to authenticate with the Vellum
 * Platform API (e.g. assistant.vellum.ai).
 */
export function getPlatformTokenPath(): string {
  return join(getRootDir(), "platform-token");
}

/**
 * Read the platform API token from disk. Returns null if the file
 * doesn't exist or can't be read.
 */
export function readPlatformToken(): string | null {
  try {
    return readFileSync(getPlatformTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Read the daemon session token from disk. Returns null if the file
 * doesn't exist or can't be read (daemon not running).
 */
export function readSessionToken(): string | null {
  try {
    return readFileSync(getSessionTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Remove a socket file only if it is actually a Unix socket.
 * Refuses to delete regular files, directories, etc. to prevent
 * accidental data loss when VELLUM_DAEMON_SOCKET points to a non-socket path.
 */
export function removeSocketFile(socketPath: string): void {
  if (!existsSync(socketPath)) return;
  const stat = statSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error(
      `Refusing to remove ${socketPath}: not a Unix socket (found ${
        stat.isFile()
          ? "regular file"
          : stat.isDirectory()
            ? "directory"
            : "non-socket"
      })`,
    );
  }
  unlinkSync(socketPath);
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
  return getWorkspaceHooksDir();
}

// --- Workspace path primitives ---
// These will become the canonical paths after workspace migration.
// Currently not used by call-sites; wired in later PRs.

/** Returns ~/.vellum/workspace — the workspace root for user-facing state. */
export function getWorkspaceDir(): string {
  return join(getRootDir(), "workspace");
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

/** Returns the workspace path for a prompt file (e.g. IDENTITY.md, SOUL.md, USER.md). */
export function getWorkspacePromptPath(file: string): string {
  return join(getWorkspaceDir(), file);
}

export function ensureDataDir(): void {
  const root = getRootDir();
  const workspace = getWorkspaceDir();
  const wsData = join(workspace, "data");
  const dirs = [
    // Root-level dirs (runtime / protected)
    root,
    join(root, "protected"),
    // Workspace dirs
    workspace,
    join(workspace, "hooks"),
    join(workspace, "skills"),
    join(workspace, "embedding-models"),
    // Data sub-dirs under workspace
    wsData,
    join(wsData, "db"),
    join(wsData, "qdrant"),
    join(wsData, "logs"),
    join(wsData, "memory"),
    join(wsData, "memory", "knowledge"),
    join(wsData, "apps"),
    join(wsData, "interfaces"),
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
