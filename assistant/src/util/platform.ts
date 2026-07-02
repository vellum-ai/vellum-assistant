import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SEEDS } from "@vellumai/environments";

import { getWorkspaceDirOverride } from "../config/env-registry.js";

/**
 * The daemon's root data directory (`~/.vellum`).
 *
 * Used as a fallback when `VELLUM_WORKSPACE_DIR` is not set, and as a
 * stable constant for paths (like `.env`) that intentionally live at the
 * host home directory regardless of workspace relocation.
 */
const VELLUM_ROOT = join(homedir(), ".vellum");

/**
 * Returns the Vellum root directory.
 *
 * Resolution order (mirrors workspace/migrations/utils.ts):
 * 1. Parent of VELLUM_WORKSPACE_DIR — e.g. /data/.vellum/workspace → /data/.vellum
 * 2. If that parent is "/" (workspace at top level), fall back to ~/.vellum
 */
export function vellumRoot(): string {
  const override = getWorkspaceDirOverride();
  if (override) {
    const parent = dirname(override);
    if (parent !== "/") return parent;
  }
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
 * Returns the internal data directory ($VELLUM_WORKSPACE_DIR/data). Runtime
 * databases, logs, memory indices, and other internal state live here.
 */
export function getDataDir(): string {
  return join(getWorkspaceDir(), "data");
}

/**
 * Returns the path to the config-quarantine notice sentinel
 * (`<workspace>/data/config-quarantine-notice.json`).
 *
 * Written by the config loader when a corrupt `config.json` is quarantined and
 * read by the per-turn `config-quarantine-notice` injector. Lives under the
 * internal data dir (runtime state, config-free to resolve) rather than the
 * user-facing workspace root because it is daemon-written bookkeeping, not a
 * file the user edits. The path resolves without loading config, so it is safe
 * to call during early-boot config load before the DB or `getConfig().dataDir`
 * exist.
 */
export function getConfigQuarantineNoticePath(): string {
  return join(getDataDir(), "config-quarantine-notice.json");
}

/**
 * Returns the embedding models directory ($VELLUM_WORKSPACE_DIR/embedding-models).
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
 * Returns the default sandbox working directory ($VELLUM_WORKSPACE_DIR).
 * This is the workspace root — tool working directories should use this
 * path unless explicitly overridden.
 */
export function getSandboxWorkingDir(): string {
  return getWorkspaceDir();
}

/**
 * Returns the sounds directory ($VELLUM_WORKSPACE_DIR/data/sounds).
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

/** Returns the canonical avatar image path ($VELLUM_WORKSPACE_DIR/data/avatar/avatar-image.png). */
export function getAvatarImagePath(): string {
  return join(getAvatarDir(), AVATAR_IMAGE_FILENAME);
}

/** Canonical filename for the avatar state manifest. */
export const AVATAR_MANIFEST_FILENAME = "avatar.json";

/** Returns the canonical avatar manifest path ($VELLUM_WORKSPACE_DIR/data/avatar/avatar.json). */
export function getAvatarManifestPath(): string {
  return join(getAvatarDir(), AVATAR_MANIFEST_FILENAME);
}

// The set of known environment names, derived from the shared
// `@vellumai/environments` seed table so this site can never drift from the
// CLI. The Swift client mirrors the same list (it can't import TS); that
// cross-language pair is guarded by `cli/src/__tests__/env-drift.test.ts`.
const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set(Object.keys(SEEDS));

/**
 * Returns the env-scoped XDG config subdirectory name for Vellum
 * (`vellum` in production, `vellum-<env>` otherwise). Mirrors the Swift
 * side's `VellumPaths.configDir` and the CLI's
 * `environments/paths.ts:getConfigDir`.
 */
export function getXdgVellumConfigDirName(): string {
  const raw = process.env.VELLUM_ENVIRONMENT?.trim();
  if (!raw || raw === "production") return "vellum";
  if (!KNOWN_ENVIRONMENTS.has(raw)) return "vellum";
  return `vellum-${raw}`;
}

export function getPidPath(): string {
  return join(getWorkspaceDir(), "vellum.pid");
}

export function getDbPath(): string {
  return join(getDataDir(), "db", "assistant.db");
}

/**
 * Returns the directory where logs live: `<dataDir>/logs/`. Files rotate
 * daily (`assistant-YYYY-MM-DD.log`), so callers ask for the directory and
 * let the logger own the filename.
 */
export function getLogsDir(): string {
  return join(getDataDir(), "logs");
}

export function getHistoryPath(): string {
  return join(getDataDir(), "history");
}

/**
 * Returns the protected directory. Security-sensitive files — trust rules,
 * encrypted credential store, signing keys, feature-flag overrides, device
 * approval lists — live here.
 *
 * This directory is:
 * - Outside the sandbox write boundary (tools cannot modify it)
 * - Skipped in containerized mode (credentials via CES, trust via gateway)
 */
export function getProtectedDir(): string {
  return join(vellumRoot(), "protected");
}

/** Returns $VELLUM_WORKSPACE_DIR/signals — the directory for IPC signal files. */
export function getSignalsDir(): string {
  return join(getWorkspaceDir(), "signals");
}

// --- Root-level runtime path helpers ---
// These expose specific root-level file paths so callers don't need to
// import getRootDir() directly. getRootDir() is intentionally unexported.

/** Returns the path to the daemon stderr log ($VELLUM_WORKSPACE_DIR/logs/daemon-stderr.log). */
export function getDaemonStderrLogPath(): string {
  return join(getWorkspaceDir(), "logs", "daemon-stderr.log");
}

/** Returns the path to the daemon startup lock file ($VELLUM_WORKSPACE_DIR/daemon-startup.lock). */
export function getDaemonStartupLockPath(): string {
  return join(getWorkspaceDir(), "daemon-startup.lock");
}

/** Returns the directory for externally-installed packages ($VELLUM_WORKSPACE_DIR/external). */
export function getExternalDir(): string {
  return join(getWorkspaceDir(), "external");
}

/** Returns the directory for installed binaries ($VELLUM_WORKSPACE_DIR/bin). */
export function getBinDir(): string {
  return join(getWorkspaceDir(), "bin");
}

/** Returns the path to the dot-env file (~/.vellum/.env). Stays at root because it contains secrets. */
export function getDotEnvPath(): string {
  return join(vellumRoot(), ".env");
}

/** Returns the path to the embed-worker PID file ($VELLUM_WORKSPACE_DIR/embed-worker.pid). */
export function getEmbedWorkerPidPath(): string {
  return join(getWorkspaceDir(), "embed-worker.pid");
}

/** Returns the path to the memory-worker PID file ($VELLUM_WORKSPACE_DIR/memory-worker.pid). */
export function getMemoryWorkerPidPath(): string {
  return join(getWorkspaceDir(), "memory-worker.pid");
}

/**
 * Returns the directory where the resource monitor persists its forensics
 * ($VELLUM_WORKSPACE_DIR/data/monitoring). Lives on the workspace volume (the
 * PVC) so the sample ring buffer and high-memory snapshots survive an OOM
 * SIGKILL that resets all in-process state. Git-ignored from the workspace
 * tree (see `data/monitoring/` in git-service.ts) so the assistant's own
 * telemetry is not auto-committed as user changes.
 */
export function getMonitoringDataDir(): string {
  return join(getDataDir(), "monitoring");
}

/** Returns the path to the monitoring PID file, under the monitor data dir. */
export function getMonitoringPidPath(): string {
  return join(getMonitoringDataDir(), "monitoring.pid");
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

/** Returns $VELLUM_WORKSPACE_DIR/config.json */
export function getWorkspaceConfigPath(): string {
  return join(getWorkspaceDir(), "config.json");
}

/** Returns $VELLUM_WORKSPACE_DIR/skills */
export function getWorkspaceSkillsDir(): string {
  return join(getWorkspaceDir(), "skills");
}

/** Returns $VELLUM_WORKSPACE_DIR/hooks */
export function getWorkspaceHooksDir(): string {
  return join(getWorkspaceDir(), "hooks");
}

/**
 * Returns `<workspaceDir>/plugins` — the directory scanned by the user plugin
 * loader at daemon startup. Writes here are security-sensitive: any
 * `register.{ts,js}` will be dynamic-imported on next restart, so the file
 * risk classifier escalates writes under this path to High.
 */
export function getWorkspacePluginsDir(): string {
  return join(getWorkspaceDir(), "plugins");
}

/**
 * Returns $VELLUM_WORKSPACE_DIR/tools — user-defined tool overrides.
 *
 * Each subdirectory `<name>/` provides either an override of a core tool of
 * the same name or a net-new tool. The single canonical location removes
 * the "which plugin wins" ambiguity that would arise if multiple plugins
 * could register competing overrides for the same tool.
 *
 * Files under this directory are dynamic-imported by the workspace-tool
 * loader on daemon start; the file risk classifier escalates writes under
 * this path to High for the same reason `plugins/` is escalated.
 */
export function getWorkspaceToolsDir(): string {
  return join(getWorkspaceDir(), "tools");
}

/**
 * Returns $VELLUM_WORKSPACE_DIR/routes — user-defined HTTP route handlers.
 *
 * Handler modules under this directory are dynamic-imported by the user-route
 * dispatcher and their exported HTTP-method functions are executed on the
 * next matching request, so the file risk classifier escalates writes under
 * this path to High for the same reason `plugins/` and `tools/` are escalated.
 */
export function getWorkspaceRoutesDir(): string {
  return join(getWorkspaceDir(), "routes");
}

/**
 * Returns $VELLUM_WORKSPACE_DIR/workflows — saved (named) workflow scripts.
 *
 * A file here becomes a saved workflow whose source is executed (in the sandbox,
 * and unattended when triggered by a schedule), so the file risk classifier
 * escalates writes under this path to High like `tools/` and `routes/`.
 */
export function getWorkspaceWorkflowsDir(): string {
  return join(getWorkspaceDir(), "workflows");
}

/** Returns $VELLUM_WORKSPACE_DIR/deprecated — transitional files slated for removal. */
export function getDeprecatedDir(): string {
  return join(getWorkspaceDir(), "deprecated");
}

/** Returns $VELLUM_WORKSPACE_DIR/conversations */
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
 *   1. macOS `.app` bundle: `Contents/Resources/bun` — bundled at a version
 *      that matches `.tool-versions`.
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
  const root = vellumRoot();
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
