import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

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
  let root = VELLUM_ROOT;
  if (override) {
    const parent = dirname(override);
    if (parent !== "/") {
      root = parent;
    }
  }
  // Same containment rule as getWorkspaceDir(): root-derived paths (protected
  // dir, .env) must stay ephemeral in test processes too.
  assertTestPathIsEphemeral(root);
  return root;
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
  if (assistantId === "self") {
    return "self";
  }

  const ownName = process.env.VELLUM_ASSISTANT_NAME;
  if (ownName && assistantId === ownName) {
    return "self";
  }

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
 * Returns the path to the config-validation-reset notice sentinel
 * (`<workspace>/data/config-validation-reset-notice.json`).
 *
 * Written by the config loader when `config.json` parses as JSON but fails
 * schema validation so hard that the loader falls back to *full* defaults
 * (e.g. an unknown key that masks a `superRefine` violation until the offending
 * key is stripped). Unlike a quarantine, the on-disk file is left untouched —
 * the user's customized values are still present but inactive until the invalid
 * entries are fixed. Read by the per-turn `config-validation-reset-notice`
 * injector so the agent can explain a settings/connection change the user did
 * not make. Lives beside the quarantine sentinel under the internal data dir
 * for the same reasons (daemon-written bookkeeping; resolves without loading
 * config, so it is safe during early-boot config load).
 */
export function getConfigValidationResetNoticePath(): string {
  return join(getDataDir(), "config-validation-reset-notice.json");
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
  if (!raw || raw === "production") {
    return "vellum";
  }
  if (!KNOWN_ENVIRONMENTS.has(raw)) {
    return "vellum";
  }
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

/** Returns the path to the schedule-worker PID file ($VELLUM_WORKSPACE_DIR/schedule-worker.pid). */
export function getScheduleWorkerPidPath(): string {
  return join(getWorkspaceDir(), "schedule-worker.pid");
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
 * Root holding every daemon-managed subprocess's runtime directory
 * ($VELLUM_WORKSPACE_DIR/procs). Each managed subprocess keeps its IPC socket,
 * PID file, and per-process scratch under `procs/<name>/`, so `ls procs` is a
 * census of managed subprocesses and cleanup is one `rm -rf` of the subdir.
 */
export function getProcsDir(): string {
  return join(getWorkspaceDir(), "procs");
}

/** The runtime directory for one managed subprocess: `procs/<name>/`. */
export function getProcDir(name: string): string {
  return join(getProcsDir(), name);
}

/** Create (if needed) and return a managed subprocess's runtime directory. */
export function ensureProcDir(name: string): string {
  const dir = getProcDir(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The IPC socket a managed subprocess binds and the daemon connects to
 * (`procs/<name>/ipc.sock`). The basename is fixed — the directory already
 * carries the subprocess name. Keep it short: Unix `sun_path` is ~104–108 bytes.
 */
export function getProcSocketPath(name: string): string {
  return join(getProcDir(name), "ipc.sock");
}

/** The PID file a managed subprocess writes on readiness (`procs/<name>/<name>.pid`). */
export function getProcPidPath(name: string): string {
  return join(getProcDir(name), `${name}.pid`);
}

// --- Live-workspace guard for test processes --------------------------------
//
// A test process must never resolve the workspace (or the vellum root) to a
// real, non-temp directory: production code exercised by a test would then
// read and destructively write live state. The tmpdir redirection normally
// comes from the bunfig.toml test preload, but bun only loads bunfig from the
// cwd, so `bun test` run from any other directory (for example a source
// checkout inside a deployed container's workspace) skips the preload and
// inherits the ambient VELLUM_WORKSPACE_DIR. The containment assertion
// therefore lives here, in production code, where it fires no matter how the
// test process was launched.
//
// Containment logic mirrors src/__tests__/assert-not-live-db.ts, which cannot
// be imported here (production code must not depend on test machinery).

/** Lazily computed: is this process a `bun test` run? */
let isTestProcess: boolean | undefined;

/**
 * Resolve symlinks in the deepest existing ancestor of `p`, then re-append
 * the not-yet-created tail. This keeps the containment check honest both for
 * paths under a symlinked temp root (macOS /var/folders) and for symlinks
 * that point outside it, whether or not the leaf exists yet.
 */
function canonicalizeForWorkspaceGuard(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) {
        return p;
      }
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

function assertTestPathIsEphemeral(dir: string): void {
  isTestProcess ??=
    process.env.NODE_ENV === "test" ||
    process.env.BUN_TEST === "1" ||
    // `bun test` sets NODE_ENV=test only when unset; Bun.main being the test
    // file itself is the backstop signal that survives a preset NODE_ENV.
    (typeof Bun !== "undefined" &&
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(Bun.main));
  if (!isTestProcess) {
    return;
  }
  // Escape hatch for the rare intentional run against a real workspace,
  // shared with assertTestDbIsIsolated() in persistence/db-connection.ts.
  // Deliberately NOT added to tools/terminal/safe-env.ts: a daemon-level
  // opt-out must not propagate into agent-spawned shells and disarm the
  // guard for tests run from there.
  if (process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS === "1") {
    return;
  }
  const tmpRoot = canonicalizeForWorkspaceGuard(tmpdir());
  const resolved = canonicalizeForWorkspaceGuard(dir);
  if (resolved !== tmpRoot && !resolved.startsWith(tmpRoot + sep)) {
    throw new Error(
      [
        `Refusing to use ${dir} (resolves to ${resolved}) in a test process: it is not under the temp directory (${tmpRoot}).`,
        "",
        "Tests must only touch an ephemeral workspace; a real one would expose",
        "live assistant state to destructive test fixtures. This usually means",
        "`bun test` ran from a cwd without the repo bunfig.toml, so the test",
        "preload that redirects VELLUM_WORKSPACE_DIR to a tmpdir never loaded.",
        "Run tests from the assistant package root, or set",
        "VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS=1 to bypass deliberately.",
      ].join("\n"),
    );
  }
}

/**
 * Returns the workspace root for user-facing state.
 *
 * When the VELLUM_WORKSPACE_DIR env var is set, returns that value (used in
 * containerized deployments where the workspace is a separate volume).
 * Otherwise falls back to ~/.vellum/workspace.
 *
 * In test processes the resolved directory must live under `os.tmpdir()`
 * (see the live-workspace guard above); anything else throws.
 */
export function getWorkspaceDir(): string {
  const dir = getWorkspaceDirOverride() ?? join(VELLUM_ROOT, "workspace");
  assertTestPathIsEphemeral(dir);
  return dir;
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

/**
 * Returns `<workspaceDir>/prompts/system` — the workspace override layer for
 * system prompt sections. Layout: `prompts/system/<NN-name>.md`.
 *
 * The bundled section registry (`prompts/templates/system-sections.ts`) is
 * the source of default truth; a file here with the same id replaces the
 * bundled body (or, stripped to nothing, silences it), and a brand-new
 * `<NN-name>` adds a workspace-only section. Because that includes the
 * security-policy sections, writes under this directory are gated as a
 * control-plane prompt surface (`permissions/workspace-policy.ts`).
 */
export function getWorkspaceSystemPromptDir(): string {
  return join(getWorkspaceDir(), "prompts", "system");
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
