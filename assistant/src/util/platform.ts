import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getWorkspaceDirOverride } from "../config/env-registry.js";

/**
 * The daemon's root data directory (`~/.vellum`).
 *
 * Multi-instance path relocation is handled by the CLI when spawning the
 * daemon (via `VELLUM_WORKSPACE_DIR` and `GATEWAY_SECURITY_DIR`); the
 * assistant itself never reads an env var for this.
 */
const VELLUM_ROOT = join(homedir(), ".vellum");

/** Returns the daemon's root data directory (`~/.vellum`). */
export function vellumRoot(): string {
  return VELLUM_ROOT;
}

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
 * Custom sound files and sound configuration live here.
 */
export function getSoundsDir(): string {
  return join(getWorkspaceDir(), "data", "sounds");
}

/** Returns the avatar directory ($VELLUM_WORKSPACE_DIR/data/avatar). */
export function getAvatarDir(): string {
  return join(getWorkspaceDir(), "data", "avatar");
}

/** Canonical filename for the custom avatar PNG. */
export const AVATAR_IMAGE_FILENAME = "avatar-image.png";

/** Returns the canonical avatar image path (~/.vellum/workspace/data/avatar/avatar-image.png). */
export function getAvatarImagePath(): string {
  return join(getAvatarDir(), AVATAR_IMAGE_FILENAME);
}

// Kept in sync with `cli/src/lib/environments/seeds.ts`. Drift between
// these two sites is caught at test time by
// `cli/src/__tests__/env-drift.test.ts`. Fast follow: hoist the shared
// list into a `packages/environments` package so both sites import
// from one place.
const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "production",
  "staging",
  "test",
  "dev",
  "local",
]);

/**
 * Returns the env-scoped XDG config subdirectory name for Vellum
 * (`vellum` in production, `vellum-<env>` otherwise). Mirrors the Swift
 * side's `VellumPaths.configDir` and the CLI's
 * `environments/paths.ts:getConfigDir` so the daemon resolves to the
 * same on-disk location as every other writer of these files.
 *
 * Unknown environment names fall back to production to preserve the
 * legacy path for any unrecognized value.
 */
export function getXdgVellumConfigDirName(): string {
  const raw = process.env.VELLUM_ENVIRONMENT?.trim();
  if (!raw || raw === "production") return "vellum";
  if (!KNOWN_ENVIRONMENTS.has(raw)) return "vellum";
  return `vellum-${raw}`;
}

/**
 * Returns the XDG-compliant path for the platform API token. Resolves to
 * `$XDG_CONFIG_HOME/vellum/platform-token` in production and
 * `$XDG_CONFIG_HOME/vellum-<env>/platform-token` otherwise, matching the
 * Swift client and CLI.
 */
export function getXdgPlatformTokenPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, getXdgVellumConfigDirName(), "platform-token");
}

/**
 * Returns the instance-scoped path to the platform API token file
 * (~/.vellum/platform-token). Used as a fallback for local assistant
 * instances that may have the token written here by the desktop app.
 */
function getPlatformTokenPath(): string {
  return join(VELLUM_ROOT, "platform-token");
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
  return join(VELLUM_ROOT, "vellum.pid");
}

/**
 * Returns the path to the runtime HTTP port file (~/.vellum/runtime-port).
 * The daemon writes its active HTTP port here on startup so thin helpers
 * that need to reach the runtime (e.g. the chrome-extension native messaging
 * helper) can locate a non-default `RUNTIME_HTTP_PORT` without a manifest
 * change. Root-level path by design — the file is read by helpers that may
 * not know the workspace override path.
 */
export function getRuntimePortFilePath(): string {
  return join(VELLUM_ROOT, "runtime-port");
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
 * - Outside the workspace
 * - Outside the sandbox write boundary (tools cannot modify it)
 * - Skipped in containerized mode (credentials via CES, trust via gateway)
 */
export function getProtectedDir(): string {
  return join(VELLUM_ROOT, "protected");
}

/** Returns ~/.vellum/workspace/signals — the directory for IPC signal files. */
export function getSignalsDir(): string {
  return join(getWorkspaceDir(), "signals");
}

// --- Root-level runtime path helpers ---
// These expose specific root-level file paths so callers don't need to
// import getRootDir() directly. getRootDir() is intentionally unexported.

/** Returns the path to the daemon stderr log (~/.vellum/workspace/logs/daemon-stderr.log). */
export function getDaemonStderrLogPath(): string {
  return join(getWorkspaceDir(), "logs", "daemon-stderr.log");
}

/** Returns the path to the daemon startup lock file (~/.vellum/workspace/daemon-startup.lock). */
export function getDaemonStartupLockPath(): string {
  return join(getWorkspaceDir(), "daemon-startup.lock");
}

/** Returns the directory for externally-installed packages (~/.vellum/workspace/external). */
export function getExternalDir(): string {
  return join(getWorkspaceDir(), "external");
}

/** Returns the directory for installed binaries (~/.vellum/workspace/bin). */
export function getBinDir(): string {
  return join(getWorkspaceDir(), "bin");
}

/** Returns the path to the dot-env file (~/.vellum/.env). Stays at root because it contains secrets. */
export function getDotEnvPath(): string {
  return join(VELLUM_ROOT, ".env");
}

/** Returns the path to the embed-worker PID file (~/.vellum/workspace/embed-worker.pid). */
export function getEmbedWorkerPidPath(): string {
  return join(getWorkspaceDir(), "embed-worker.pid");
}

/**
 * Returns the workspace root for user-facing state.
 *
 * When the VELLUM_WORKSPACE_DIR env var is set, returns that value (used in
 * containerized deployments where the workspace is a separate volume).
 * Otherwise falls back to ~/.vellum/workspace.
 */
export function getWorkspaceDir(): string {
  const override = getWorkspaceDirOverride();
  if (override) return override;
  return join(VELLUM_ROOT, "workspace");
}

/**
 * Returns a display-friendly workspace path for embedding in agent-facing text
 * (skill bodies, tool descriptions). Replaces the home directory prefix with `~`
 * so paths stay concise and portable across machines.
 *
 * Examples:
 *   /Users/alice/.vellum/workspace → ~/.vellum/workspace
 *   /data/.vellum/workspace        → /data/.vellum/workspace
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

/** Returns $VELLUM_WORKSPACE_DIR/routes — user-defined HTTP route handlers. */
export function getWorkspaceRoutesDir(): string {
  return join(getWorkspaceDir(), "routes");
}

/** Returns ~/.vellum/workspace/deprecated — transitional files slated for removal. */
export function getDeprecatedDir(): string {
  return join(getWorkspaceDir(), "deprecated");
}

/** Returns ~/.vellum/workspace/conversations */
export function getConversationsDir(): string {
  return join(getWorkspaceDir(), "conversations");
}

/** Returns the workspace path for a prompt file (e.g. IDENTITY.md, SOUL.md). */
export function getWorkspacePromptPath(file: string): string {
  return join(getWorkspaceDir(), file);
}

// ── Profiler filesystem layout ──────────────────────────────────────────
// Managed profiler runs live under <workspace>/data/profiler/. These
// helpers enforce a single canonical layout so every runtime caller
// resolves the same paths.

/**
 * Returns the profiler root directory (<workspace>/data/profiler).
 * All profiler state (runs directory, global metadata) lives here.
 */
export function getProfilerRootDir(): string {
  return join(getDataDir(), "profiler");
}

/**
 * Returns the profiler runs directory (<workspace>/data/profiler/runs).
 * Each completed or active profiler run gets its own sub-directory here.
 */
export function getProfilerRunsDir(): string {
  return join(getProfilerRootDir(), "runs");
}

/**
 * Returns the directory for a specific profiler run by ID
 * (<workspace>/data/profiler/runs/<runId>).
 */
export function getProfilerRunDir(runId: string): string {
  return join(getProfilerRunsDir(), runId);
}

/**
 * Resolve the shipped source directory for a first-party skill (e.g.
 * `meet-join`) whose runtime is launched outside the compiled daemon
 * binary — notably the meet-host child process spawned via
 * `bun run <skill>/register.ts`.
 *
 * Layers on top of `getRepoSkillsDir()` from `skills/catalog-install.ts`:
 * that helper locates the first-party skills root (validated by
 * `catalog.json`); this helper appends the skill id and validates the
 * per-skill entry point (`register.ts`). Returns `undefined` when the
 * root is unavailable (e.g. dev-mode build without `VELLUM_DEV=1`) or
 * the skill directory has no `register.ts`.
 *
 * Implemented here instead of `skills/catalog-install.ts` to avoid
 * pulling that module's platform-API dependencies (fetch, memory graph)
 * into callers that only need a path resolution. Takes the first-party
 * skills root as a dependency to keep this module free of a reverse
 * import.
 */
export function getSkillRuntimePath(
  skillId: string,
  firstPartySkillsRoot: string | undefined,
): string | undefined {
  if (!firstPartySkillsRoot) return undefined;
  const candidate = join(firstPartySkillsRoot, skillId);
  if (existsSync(join(candidate, "register.ts"))) {
    return candidate;
  }
  return undefined;
}

/**
 * Resolve the on-disk path to a standalone `bun` binary that the meet-host
 * supervisor (PR 27) uses to spawn external skills. Prefers the
 * packaging-site-bundled copy before falling back to the shared
 * download/PATH resolver in `bun-runtime.ts`.
 *
 * Resolution order:
 *
 *   1. macOS `.app` bundle: `Contents/Resources/bun` — shipped by
 *      `clients/macos/build.sh` at a version that matches `.tool-versions`.
 *   2. Next-to-binary: `<execDir>/bun` for Docker/generic compiled layouts
 *      that stage a bun binary alongside the daemon (PR 29 wires this up).
 *
 * Returns `undefined` when no bundled copy is present; callers should
 * fall back to `ensureBun()` from `./bun-runtime.ts`, which handles PATH
 * lookup and JIT download for bare-metal dev.
 */
export function getBundledBunPath(): string | undefined {
  const importDir = import.meta.dir;
  if (!importDir.startsWith("/$bunfs/")) return undefined;

  const execDir = dirname(process.execPath);
  const resourcesPath = join(execDir, "..", "Resources", "bun");
  if (existsSync(resourcesPath)) return resourcesPath;
  const execDirPath = join(execDir, "bun");
  if (existsSync(execDirPath)) return execDirPath;
  return undefined;
}

export function ensureDataDir(): void {
  const root = VELLUM_ROOT;
  const workspace = getWorkspaceDir();
  const wsData = join(workspace, "data");
  const dirs = [
    // Root-level dirs (runtime)
    root,
    // Workspace dirs
    workspace,
    join(workspace, "signals"),
    join(workspace, "skills"),
    join(workspace, "routes"),
    join(workspace, "embedding-models"),
    join(workspace, "conversations"),
    join(workspace, "logs"),
    join(workspace, "external"),
    join(workspace, "bin"),
    // Data sub-dirs under workspace
    wsData,
    join(wsData, "db"),
    join(wsData, "qdrant"),
    join(wsData, "logs"),
    join(wsData, "memory"),
    join(wsData, "memory", "knowledge"),
    join(wsData, "apps"),
    join(wsData, "attachments"),
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
