import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getWorkspaceDirOverride } from "../config/env-registry.js";

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
 * Normalize an assistant ID to its canonical form for DB operations.
 *
 * The system uses "self" as the canonical single-tenant identifier
 * (see migration 007-assistant-id-to-self). However, the desktop UI
 * sends the real assistant ID (e.g., "vellum-true-eel") while the
 * inbound call path resolves phone numbers to config keys (typically
 * "self"). This function maps the current assistant's ID to "self"
 * so both sides use a consistent DB key.
 */
export function normalizeAssistantId(assistantId: string): string {
  if (assistantId === "self") return "self";

  const ownName = process.env.VELLUM_ASSISTANT_NAME;
  if (ownName && assistantId === ownName) return "self";

  return assistantId;
}

/**
 * Compute the root ~/.vellum directory path.
 *
 * This is a simple inline computation — not a shared function — so each
 * helper is self-contained and the module has no hidden coupling to
 * env-var indirection.
 */
function vellumRoot(): string {
  return join(homedir(), ".vellum");
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
  return existsSync(join(vellumRoot(), "tcp-enabled"));
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
  return existsSync(join(vellumRoot(), "ios-pairing-enabled"));
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
  return join(vellumRoot(), "platform-token");
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
  return join(vellumRoot(), "vellum.pid");
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

/**
 * Returns the protected directory (~/.vellum/protected). Security-sensitive
 * files — trust rules, encrypted credential store, signing keys, feature-flag
 * overrides, device approval lists — live here.
 *
 * This directory is:
 * - Outside the workspace (not included in diagnostic exports)
 * - Outside the sandbox write boundary (tools cannot modify it)
 * - Skipped in containerized mode (credentials via CES, trust via gateway)
 */
export function getProtectedDir(): string {
  return join(vellumRoot(), "protected");
}

/** Returns ~/.vellum/workspace/signals — the directory for IPC signal files. */
export function getSignalsDir(): string {
  return join(getWorkspaceDir(), "signals");
}

// --- Root-level runtime path helpers ---
// These expose specific root-level file paths so callers don't need to
// import getRootDir() directly. getRootDir() is intentionally unexported.

/** Returns the path to the daemon stderr log (~/.vellum/daemon-stderr.log). */
export function getDaemonStderrLogPath(): string {
  return join(vellumRoot(), "daemon-stderr.log");
}

/** Returns the path to the daemon startup lock file (~/.vellum/daemon-startup.lock). */
export function getDaemonStartupLockPath(): string {
  return join(vellumRoot(), "daemon-startup.lock");
}

/** Returns the path to the feature-flag client token file (~/.vellum/feature-flag-token). */
export function getFeatureFlagTokenPath(): string {
  return join(vellumRoot(), "feature-flag-token");
}

/** Returns the directory for externally-installed packages (~/.vellum/external). */
export function getExternalDir(): string {
  return join(vellumRoot(), "external");
}

/** Returns the directory for installed binaries (~/.vellum/bin). */
export function getBinDir(): string {
  return join(vellumRoot(), "bin");
}

/** Returns the path to the dot-env file (~/.vellum/.env). */
export function getDotEnvPath(): string {
  return join(vellumRoot(), ".env");
}

/** Returns the path to the embed-worker PID file (~/.vellum/embed-worker.pid). */
export function getEmbedWorkerPidPath(): string {
  return join(vellumRoot(), "embed-worker.pid");
}

/**
 * Returns the root dir path for use in backward-compatible env vars
 * (e.g. VELLUM_ROOT_DIR passed to hook scripts).
 *
 * Unlike `dirname(getWorkspaceDir())`, this always returns the true root
 * (~/.vellum) even when VELLUM_WORKSPACE_DIR is overridden to a custom
 * path (Docker / containerized mode).
 *
 * @deprecated Callers should migrate to workspace-based paths. This helper
 * exists only for backward compatibility with user-authored hook scripts.
 */
export function getLegacyRootDir(): string {
  return vellumRoot();
}

// --- Workspace path primitives ---
// These will become the canonical paths after workspace migration.
// Currently not used by call-sites; wired in later PRs.

/**
 * Returns the workspace root for user-facing state.
 *
 * When the VELLUM_WORKSPACE_DIR env var is set, returns that value (used in
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
  return join(vellumRoot(), "workspace");
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
  const root = vellumRoot();
  const workspace = getWorkspaceDir();
  const wsData = join(workspace, "data");
  const dirs = [
    // Root-level dirs (runtime)
    root,
    // Workspace dirs
    workspace,
    join(workspace, "signals"),
    join(workspace, "hooks"),
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
