/**
 * Workspace tool loader — discovers and registers tool overrides from
 * `<workspaceDir>/tools/<name>.{ts,js,json}`, plus `<name>.removed`
 * sentinel files that strip a core tool from the registry without
 * substituting a replacement.
 *
 *     <workspaceDir>/
 *       tools/
 *         skill_load.ts           ← name="skill_load" via .ts default export
 *         my_tool.js              ← name="my_tool" via compiled .js (preferred over .ts)
 *         data_lookup.json        ← name="data_lookup" via JSON spec (no execute)
 *         host_bash.removed       ← name="host_bash" — strip from registry
 *
 * The filename stem is the registered tool name verbatim — there is no
 * derivation, no basename transformation, no directory layer. This is the
 * documented "directory name is the tool name verbatim" contract, just
 * shifted one level up so each tool is a single file instead of a
 * sub-directory.
 *
 * Override / strip semantics live in the registry
 * ({@link registerWorkspaceTools}, {@link removeCoreToolViaWorkspace}):
 * if a core tool already owns the name, the original is stashed; the
 * workspace tool (or absence-of-tool, for `.removed`) takes its place.
 * Plugins, skills, and MCP servers all refuse to register over a
 * workspace-owned or workspace-stripped name.
 *
 * Lifecycle position:
 *
 *     initializeTools()
 *       → loadWorkspaceTools()       ← this module (first scan)
 *         → loadUserPlugins()
 *           → bootstrapPlugins()
 *
 * Plugins load *after* the initial workspace-tool scan so the registry
 * hands them a stable view of which workspace tools exist before any
 * plugin code runs.
 *
 * ## Reconcile on read, not on a watcher
 *
 * {@link loadWorkspaceTools} is idempotent and safe to call repeatedly:
 * after the initial scan it reconciles the registry against on-disk
 * state. Each call re-derives "given what's on disk right now under
 * `tools/`, what registry state should the assistant be in?" and applies
 * the delta — registering newly added tools, re-importing changed tools
 * (mtime-gated, cache-busting via the per-import URL query string),
 * unregistering deleted tools, stripping core tools when a `.removed`
 * sentinel appears, and restoring them when it disappears.
 *
 * Instead of a long-lived filesystem watcher, the per-turn tool resolver
 * (`createResolveToolsCallback` in `conversation-tool-setup.ts`) kicks this
 * reconcile and then re-reads workspace tools from the registry — the same
 * way it re-reads MCP tools — so a conversation picks up on-disk edits
 * without a restart and without recreating the conversation. The "edit a
 * file, see the change" loop closes on the next turn. Unchanged files are
 * skipped via the mtime cache, so a no-op reconcile costs one `readdir`
 * plus a `stat` per file and never re-imports.
 *
 * Per-tool isolation:
 *
 * - A file with a name that fails {@link isProviderSafeToolName} is
 *   logged at error and skipped — we never silently rewrite the name
 *   via hashing at registration time (which would mask the operator's
 *   typo behind an unfindable hashed identifier).
 * - A `.ts` whose module body throws during import is logged at error
 *   and skipped — one broken workspace tool must never block boot.
 * - A `.json` that doesn't parse, or doesn't produce an object, is
 *   logged at error and skipped.
 * - A hung dynamic `import()` is bounded by {@link IMPORT_TIMEOUT_MS}
 *   and the offending file is skipped. Same contract as the plugin
 *   loader: bun's `import()` cannot be cancelled, so an abandoned
 *   import keeps running in the background but the registry guards
 *   against late-arriving registrations because we already moved past it.
 *
 * The loader registers tools in a single {@link registerWorkspaceTools}
 * call so the batch-level validation can catch duplicate names across
 * the directory listing before any mutation lands.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceToolsDir } from "../../util/platform.js";
import { isProviderSafeToolName } from "../provider-tool-name.js";
import {
  getCoreToolOverride,
  getTool,
  getToolOwner,
  registerWorkspaceTools,
  removeCoreToolViaWorkspace,
  restoreStrippedCoreTool,
  unregisterWorkspaceTool,
} from "../registry.js";
import { finalizeTool } from "../tool-defaults.js";
import type { RiskLevel } from "../tool-types.js";
import type { Tool, ToolDefinition, ToolExecutionResult } from "../types.js";

const log = getLogger("workspace-tool-loader");

/**
 * Upper bound on how long a single workspace tool's dynamic `import()` may
 * take. A tool with a hanging top-level `await` (or a never-resolving
 * module evaluation) would otherwise block daemon startup indefinitely,
 * since a raw `try/catch` only isolates thrown errors — not hung
 * promises. Ten seconds matches the plugin-loader budget for the same
 * isolation reason.
 */
const IMPORT_TIMEOUT_MS = 10_000;

/**
 * File-extension precedence for live tool files. When two files share
 * the same stem (e.g. `tool.ts` + `tool.js`), the loader picks the
 * earlier-listed extension and warns about the rest. Mirrors the
 * external-plugin loader's compiled-binary semantics.
 */
const LIVE_TOOL_EXTENSIONS = [".js", ".ts", ".json"] as const;
type LiveToolExtension = (typeof LIVE_TOOL_EXTENSIONS)[number];

/** Extension of the "strip core tool" sentinel. */
const REMOVED_EXTENSION = ".removed" as const;

/**
 * Defaults applied when a workspace tool omits one of the normally-required
 * fields. Workspace tools default `defaultRiskLevel` to `"high"` (vs
 * `"medium"` for plugin tools) because they run arbitrary on-disk code
 * under the operator's workspace, so the floor is higher than for
 * in-tree-vetted plugin code.
 *
 * The default `execute` returns an error result so the model sees a clear
 * signal that the tool isn't wired up. The tool still loads cleanly — a
 * broken tool must never block daemon boot.
 */
const WORKSPACE_TOOL_DEFAULTS = Object.freeze({
  defaultRiskLevel: "high" as RiskLevel,
});

/**
 * Validate that a filename stem is a usable tool name. Tool names must be
 * provider-safe (`[a-zA-Z0-9_-]{1,64}`) so they can be sent verbatim to
 * the LLM provider without the registry's hash-suffix rewrite kicking in
 * and producing an unfindable name like `my tool__abc123def456`. Names
 * starting with `.` are intentionally excluded so dotfiles (.DS_Store,
 * .gitignore, etc.) cannot accidentally claim a tool.
 */
function isValidToolFilenameStem(stem: string): boolean {
  if (stem.length === 0) {
    return false;
  }
  if (stem.startsWith(".")) {
    return false;
  }
  return isProviderSafeToolName(stem);
}

/**
 * Strip the recognized extension off a filename and return the stem, or
 * `undefined` if the filename doesn't match any recognized extension.
 *
 * Distinguishes between live tool files (`.ts` / `.js` / `.json`) and the
 * `.removed` sentinel so the caller can route each kind to the right
 * code path.
 */
function classifyEntry(
  entry: string,
):
  | { kind: "live"; stem: string; ext: LiveToolExtension }
  | { kind: "removed"; stem: string }
  | undefined {
  const ext = extname(entry);
  if (ext === REMOVED_EXTENSION) {
    return { kind: "removed", stem: entry.slice(0, -REMOVED_EXTENSION.length) };
  }
  for (const candidate of LIVE_TOOL_EXTENSIONS) {
    if (ext === candidate) {
      return {
        kind: "live",
        stem: entry.slice(0, -candidate.length),
        ext: candidate,
      };
    }
  }
  return undefined;
}

/**
 * When multiple live files share the same stem (e.g. `foo.ts` + `foo.js`),
 * pick the highest-precedence one per {@link LIVE_TOOL_EXTENSIONS} and
 * return the dropped sibling paths so the caller can warn.
 */
interface LiveSelection {
  ext: LiveToolExtension;
  shadowed: LiveToolExtension[];
}

function selectLiveExtension(
  extensions: Set<LiveToolExtension>,
): LiveSelection {
  for (const candidate of LIVE_TOOL_EXTENSIONS) {
    if (extensions.has(candidate)) {
      const shadowed: LiveToolExtension[] = [];
      for (const ext of LIVE_TOOL_EXTENSIONS) {
        if (ext !== candidate && extensions.has(ext)) {
          shadowed.push(ext);
        }
      }
      return { ext: candidate, shadowed };
    }
  }
  // Unreachable — caller guarantees `extensions` is non-empty.
  throw new Error("selectLiveExtension called with empty set");
}

/**
 * Apply workspace-specific defaults on top of the generic
 * {@link finalizeTool} pipeline. The shared finalizer handles the bulk
 * of the omitted-field filling; we layer two workspace-only overrides
 * on top:
 *
 * 1. `defaultRiskLevel` defaults to `"high"` for workspace tools — they
 *    run with full user privilege from disk, so the safety floor is set
 *    higher than the generic `"medium"` baseline.
 * 2. The default `execute` mentions "workspace tool" so the model gets
 *    a clearer "the workspace file at this name has no executor wired
 *    up" signal in the failure transcript.
 *
 * The tool still loads cleanly with these defaults — a broken tool must
 * never block daemon boot. Always sets `category: "workspace"` so the
 * registry can distinguish workspace overrides from other origins.
 *
 * The registered name is pinned to the filename stem (`name`), overriding
 * any `name` field on the file's own export. This is the documented
 * "filename stem is the tool name verbatim" contract — `finalizeTool`
 * would otherwise prefer `tool.name` — and it keeps the registered name in
 * lockstep with the stem the reconcile keys its mtime cache by, so a later
 * delete of the file unregisters the right tool.
 */
function applyWorkspaceToolDefaults(tool: ToolDefinition, name: string): Tool {
  const finalized = finalizeTool(
    {
      ...tool,
      name,
      defaultRiskLevel:
        tool.defaultRiskLevel ?? WORKSPACE_TOOL_DEFAULTS.defaultRiskLevel,
      category: tool.category ?? "workspace",
      execute:
        typeof tool.execute === "function"
          ? tool.execute
          : async (): Promise<ToolExecutionResult> => ({
              content: `workspace tool ${name} has no execute implementation`,
              isError: true,
            }),
    },
    name,
  );
  return finalized;
}

/**
 * Dynamic-import `absolutePath` with a timeout. Resolves to the imported
 * module's default export, or `undefined` if the import times out, has
 * no default export, or throws.
 *
 * A cache-busting `?v=<counter>` query string is appended so a reconcile
 * that re-imports a changed file picks up the new contents instead of the
 * module bun already transpiled. The counter is per-call, so every import
 * gets a fresh module identity.
 *
 * The specifier is the raw absolute path (not a `file://` URL): bun honors
 * the `?v=` query for cache-busting on a bare absolute path but collapses
 * it to the same cached module for a `file://` URL, which would silently
 * serve stale source on re-import. Absolute paths (and embedded spaces)
 * import cleanly; only `?`/`#` in the path would confuse the query, and
 * tool stems are provider-safe so the directory prefix is the only place
 * those could appear.
 *
 * All failure paths log with file attribution so operators can find the
 * broken tool quickly.
 */
let importCounter = 0;

async function importToolDefaultBounded(
  entryPath: string,
  timeoutMs: number,
): Promise<unknown> {
  const url = `${entryPath}?v=${++importCounter}`;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSentinel = Symbol("workspace-tool-import-timeout");
    const importPromise = import(url) as Promise<{ default?: unknown }>;
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
    });
    const result = await Promise.race([importPromise, timeoutPromise]);
    if (result === timeoutSentinel) {
      // Abandoned import — attach a terminal `.catch` so a late
      // rejection cannot surface as an unhandled-rejection crash.
      importPromise.catch(() => {
        /* swallow — module is dead to the daemon */
      });
      log.warn(
        { entryPath, timeoutMs },
        `Timed out importing workspace tool from ${entryPath} after ${timeoutMs}ms — skipping`,
      );
      return undefined;
    }
    if (result.default === undefined) {
      log.error(
        { entryPath },
        `Workspace tool at ${entryPath} has no default export — skipping`,
      );
      return undefined;
    }
    return result.default;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, entryPath },
      `Failed to import workspace tool from ${entryPath}: ${message}`,
    );
    return undefined;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Read a `.json` tool spec and return its parsed shape, or `undefined`
 * if the file can't be read or doesn't parse to an object.
 *
 * JSON specs can't carry an `execute` function (JSON has no function
 * type), so they always pick up the default error-result executor. They
 * exist for declarative use cases — schema-only tool stubs, override
 * placeholders, etc.
 */
async function readJsonToolSpec(
  entryPath: string,
): Promise<ToolDefinition | undefined> {
  let raw: string;
  try {
    raw = await readFile(entryPath, "utf8");
  } catch (err) {
    log.error(
      { err, entryPath },
      `Failed to read JSON workspace tool at ${entryPath} — skipping`,
    );
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, entryPath },
      `Failed to parse JSON workspace tool at ${entryPath}: ${message} — skipping`,
    );
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.error(
      { entryPath, type: typeof parsed },
      `JSON workspace tool at ${entryPath} must be an object — skipping`,
    );
    return undefined;
  }
  return parsed as ToolDefinition;
}

export interface LoadWorkspaceToolsOptions {
  /**
   * Maximum time to spend importing each tool file before bailing.
   * Defaults to {@link IMPORT_TIMEOUT_MS}.
   */
  readonly importTimeoutMs?: number;
}

/**
 * Result of a {@link loadWorkspaceTools} call — the names workspace tools
 * currently own and the core-tool names currently stripped via
 * `<name>.removed` sentinels, reflecting the registry state after the
 * reconcile applied its delta.
 */
export interface LoadWorkspaceToolsResult {
  /** Tool names currently registered as workspace tools. */
  readonly registered: string[];
  /** Core-tool names currently stripped via `<name>.removed` sentinels. */
  readonly removed: string[];
}

/**
 * What the loader last established on disk for a given stem. The mtime
 * cache lets a repeat {@link loadWorkspaceTools} call skip re-importing a
 * file that hasn't changed since the previous reconcile — a no-op
 * reconcile costs one `readdir` plus a `stat` per file and never touches
 * the registry.
 */
type ManagedEntry =
  | { kind: "live"; ext: LiveToolExtension; mtimeMs: number }
  | { kind: "removed" };

/**
 * Per-stem record of the workspace-tool state this module installed on the
 * last reconcile. Module-level (process-wide) because the registry it
 * mirrors is also process-wide. Reset between tests via
 * {@link __resetWorkspaceToolCacheForTesting}.
 */
const managed = new Map<string, ManagedEntry>();

/**
 * The winning live file for a stem, resolved from the on-disk scan.
 */
interface DesiredLiveEntry {
  readonly ext: LiveToolExtension;
  readonly mtimeMs: number;
  readonly path: string;
}

/**
 * Pure (no registry mutation) scan of `<workspaceDir>/tools/`. Resolves
 * each stem to its winning live file (with mtime) and the set of stems
 * carrying a `.removed` sentinel, applying the same validation and
 * shadow/ambiguity rules the reconcile relies on. Returns empty maps when
 * the directory is missing or unreadable.
 */
function scanWorkspaceToolsDir(toolsDir: string): {
  desiredLive: Map<string, DesiredLiveEntry>;
  removedStems: Set<string>;
} {
  const desiredLive = new Map<string, DesiredLiveEntry>();
  const removedStems = new Set<string>();

  if (!existsSync(toolsDir)) {
    return { desiredLive, removedStems };
  }

  let entries: string[];
  try {
    entries = readdirSync(toolsDir);
  } catch (err) {
    log.warn(
      { err, toolsDir },
      "loadWorkspaceTools: failed to read tools directory — continuing with no workspace tools",
    );
    return { desiredLive, removedStems };
  }

  // Group entries by stem so we can detect multi-extension shadowing
  // (e.g. `foo.ts` + `foo.js` claiming the same name) before we kick off
  // any imports. Each stem maps to its live extensions (with mtimes);
  // .removed sentinels are tracked separately since they're mutually
  // exclusive with live tool files (you don't strip AND register at once).
  const liveByStem = new Map<string, Map<LiveToolExtension, number>>();

  for (const entry of entries) {
    const fullPath = join(toolsDir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch (err) {
      log.warn(
        { err, fullPath },
        "loadWorkspaceTools: failed to stat candidate — skipping",
      );
      continue;
    }
    if (!stats.isFile()) {
      // Subdirectories, symlinks-to-dir, sockets, etc. are silently
      // ignored. The convention is per-tool single files at the top
      // of `<workspaceDir>/tools/`.
      continue;
    }

    const classified = classifyEntry(entry);
    if (!classified) {
      continue;
    }
    if (!isValidToolFilenameStem(classified.stem)) {
      log.error(
        { entry, stem: classified.stem, toolsDir },
        `loadWorkspaceTools: filename stem "${classified.stem}" is not a provider-safe tool name (must match /^[a-zA-Z0-9_-]{1,64}$/) — skipping`,
      );
      continue;
    }

    if (classified.kind === "removed") {
      removedStems.add(classified.stem);
      continue;
    }
    let extensions = liveByStem.get(classified.stem);
    if (!extensions) {
      extensions = new Map<LiveToolExtension, number>();
      liveByStem.set(classified.stem, extensions);
    }
    extensions.set(classified.ext, stats.mtimeMs);
  }

  // A stem cannot both be live AND removed. Operator intent is ambiguous;
  // log and skip both entries for that name so neither lands.
  for (const stem of removedStems) {
    if (liveByStem.has(stem)) {
      log.error(
        { stem, toolsDir },
        `loadWorkspaceTools: "${stem}" has both a live tool file and a .removed sentinel — skipping both (ambiguous intent)`,
      );
      liveByStem.delete(stem);
      removedStems.delete(stem);
    }
  }

  // Resolve each live stem to its winning extension. Multi-extension
  // shadowing warns once per ignored sibling so the operator can clean up
  // the redundant file.
  for (const [stem, extensions] of liveByStem) {
    const { ext: winningExt, shadowed } = selectLiveExtension(
      new Set(extensions.keys()),
    );
    if (shadowed.length > 0) {
      log.warn(
        { stem, winningExt, shadowed, toolsDir },
        `loadWorkspaceTools: "${stem}" has multiple files (${[winningExt, ...shadowed].join(", ")}) — using ${winningExt} and ignoring the rest`,
      );
    }
    desiredLive.set(stem, {
      ext: winningExt,
      mtimeMs: extensions.get(winningExt) ?? 0,
      path: join(toolsDir, `${stem}${winningExt}`),
    });
  }

  return { desiredLive, removedStems };
}

/**
 * Tear down any workspace-tool state this module owns for `stem`:
 * unregister a live workspace tool (restoring a stashed core tool if the
 * workspace tool overrode one), and restore a core tool previously
 * stripped via a `.removed` sentinel. Both are no-ops when there is
 * nothing to undo, so this is safe to call for any stem.
 */
function teardownStem(stem: string): void {
  if (getToolOwner(stem)?.kind === "workspace") {
    unregisterWorkspaceTool(stem);
  }
  if (getCoreToolOverride(stem) && !getTool(stem)) {
    restoreStrippedCoreTool(stem);
  }
}

/**
 * Import and finalize the winning live file for `stem`, returning the
 * registry-ready {@link Tool} or `undefined` when the file fails to load
 * (every failure is logged with file attribution and never thrown).
 */
async function loadDesiredLiveTool(
  stem: string,
  entry: DesiredLiveEntry,
  importTimeoutMs: number,
): Promise<Tool | undefined> {
  let toolSpec: ToolDefinition | undefined;
  if (entry.ext === ".json") {
    toolSpec = await readJsonToolSpec(entry.path);
  } else {
    const defaultExport = await importToolDefaultBounded(
      entry.path,
      importTimeoutMs,
    );
    if (defaultExport === undefined) {
      return undefined;
    } // Failure already logged.
    if (defaultExport === null || typeof defaultExport !== "object") {
      log.error(
        { entryPath: entry.path, type: typeof defaultExport },
        `Workspace tool at ${entry.path} default export must be an object — skipping`,
      );
      return undefined;
    }
    toolSpec = defaultExport as ToolDefinition;
  }
  if (!toolSpec) {
    return undefined;
  }
  return applyWorkspaceToolDefaults(toolSpec, stem);
}

/**
 * The currently-running reconcile, if any. Concurrent callers coalesce onto
 * it so the per-turn fire-and-forget kicks from many conversations can't
 * pile up or interleave their unregister/register sequences against the
 * shared registry. Once it settles this is cleared, so a later caller (the
 * next turn, or a sequential awaiter like boot/tests) starts a fresh scan.
 */
let inflightReconcile: Promise<LoadWorkspaceToolsResult> | null = null;

/**
 * Reconcile the registry's workspace-tool layer against
 * `<workspaceDir>/tools/`.
 *
 * Idempotent and safe to call repeatedly: the first call registers every
 * well-formed `<name>.{ts,js,json}` as a workspace tool and strips core
 * tools named by `<name>.removed` sentinels; subsequent calls apply only
 * the delta since the previous reconcile — registering added files,
 * re-importing changed files (detected by mtime), unregistering deleted
 * files, and restoring core tools whose sentinel was removed.
 *
 * Invariants:
 *
 * - No-ops to an empty registry footprint when the tools directory does
 *   not exist, tearing down anything a previous reconcile installed.
 * - Per-tool isolation: any single broken tool is logged and skipped
 *   without aborting the reconcile. The function resolves normally even
 *   when every candidate fails.
 * - Concurrency-safe: concurrent callers coalesce onto a single in-flight
 *   reconcile, so the unregister/register sequence for a changed tool never
 *   races another reconcile.
 *
 * Caller responsibilities:
 *
 * - The first call must run between {@link initializeTools} and
 *   {@link loadUserPlugins}. Calling earlier risks racing core
 *   registrations; calling later means plugins see an incomplete
 *   registry and may register over a name a workspace tool will later
 *   try to own. Later calls (driven by the per-turn tool resolver) are
 *   free to run any time — the reconcile only ever touches
 *   workspace-owned and core-stashed names.
 */
export function loadWorkspaceTools(
  options: LoadWorkspaceToolsOptions = {},
): Promise<LoadWorkspaceToolsResult> {
  if (inflightReconcile) {
    return inflightReconcile;
  }
  // `reconcileWorkspaceTools` never rejects (all failures are caught and
  // logged); `.finally` clears the slot either way so the next caller scans
  // fresh.
  inflightReconcile = reconcileWorkspaceTools(options).finally(() => {
    inflightReconcile = null;
  });
  return inflightReconcile;
}

async function reconcileWorkspaceTools(
  options: LoadWorkspaceToolsOptions,
): Promise<LoadWorkspaceToolsResult> {
  const importTimeoutMs = options.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
  const toolsDir = getWorkspaceToolsDir();

  const { desiredLive, removedStems } = scanWorkspaceToolsDir(toolsDir);

  // Snapshot what we managed before so we can detect stems that vanished
  // from disk entirely (present last time, absent now) and tear them down.
  const prevManaged = new Map(managed);

  // 1. Tear down stems we previously managed that disk no longer mentions
  //    (neither a live file nor a .removed sentinel). Stems still present
  //    are handled by the live/removed passes below.
  for (const stem of prevManaged.keys()) {
    if (!desiredLive.has(stem) && !removedStems.has(stem)) {
      teardownStem(stem);
      managed.delete(stem);
    }
  }

  // 2. `.removed` sentinels — strip the named core tool. Unregister any
  //    prior workspace registration for the stem first so the strip path
  //    sees a core (or empty) baseline rather than a workspace override.
  for (const stem of removedStems) {
    if (getToolOwner(stem)?.kind === "workspace") {
      unregisterWorkspaceTool(stem);
    }
    try {
      removeCoreToolViaWorkspace(stem);
      managed.set(stem, { kind: "removed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, stem },
        `loadWorkspaceTools: failed to strip core tool "${stem}": ${message}`,
      );
      managed.delete(stem);
    }
  }

  // 3. Live tools — register new files, re-import changed files (mtime
  //    differs), skip unchanged ones. Each entry is imported and registered
  //    on its own so one broken or conflicting file cannot drop the others
  //    (per-tool isolation): the import is bounded/caught, and registration
  //    goes through registerWorkspaceTools one tool at a time. Stems are the
  //    map keys here, so there are no intra-reconcile duplicate names that a
  //    batch would otherwise need to validate.
  for (const [stem, entry] of desiredLive) {
    const prev = prevManaged.get(stem);
    const unchanged =
      prev?.kind === "live" &&
      prev.ext === entry.ext &&
      prev.mtimeMs === entry.mtimeMs &&
      getToolOwner(stem)?.kind === "workspace";
    if (unchanged) {
      managed.set(stem, {
        kind: "live",
        ext: entry.ext,
        mtimeMs: entry.mtimeMs,
      });
      continue;
    }

    // Changed, or a fresh import is needed. Import FIRST and only mutate the
    // registry once we hold a valid tool, so a failed re-import leaves the
    // previously-registered version in place rather than tearing it down.
    const tool = await loadDesiredLiveTool(stem, entry, importTimeoutMs);
    if (!tool) {
      // Import failed (already logged). Leave any prior registration intact
      // and keep the managed entry so a later fix re-imports cleanly.
      continue;
    }

    // Drop any prior workspace registration so the loader re-registers
    // cleanly, and restore a previously-stripped core tool so the override
    // path sees the expected baseline (core present → stash + replace).
    if (getToolOwner(stem)?.kind === "workspace") {
      unregisterWorkspaceTool(stem);
    }
    if (getCoreToolOverride(stem) && !getTool(stem)) {
      restoreStrippedCoreTool(stem);
    }

    try {
      registerWorkspaceTools([{ tool, workspacePath: entry.path }]);
      managed.set(stem, {
        kind: "live",
        ext: entry.ext,
        mtimeMs: entry.mtimeMs,
      });
    } catch (err) {
      // A throw means a hard conflict for this name (e.g. a plugin/MCP tool
      // already owns it — a lifecycle-order regression). Surface it loudly,
      // but do NOT rethrow and do NOT abort the other tools — startup /
      // conversation reads must still complete.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, stem, toolsDir },
        `loadWorkspaceTools: registry rejected "${stem}" — ${message}`,
      );
      managed.delete(stem);
    }
  }

  // Derive the result from the final registry state so it reflects what
  // actually landed rather than what we attempted.
  const registered: string[] = [];
  const removed: string[] = [];
  for (const [stem, entry] of managed) {
    if (entry.kind === "live" && getToolOwner(stem)?.kind === "workspace") {
      registered.push(stem);
    } else if (
      entry.kind === "removed" &&
      getCoreToolOverride(stem) &&
      !getTool(stem)
    ) {
      removed.push(stem);
    }
  }

  if (registered.length === 0 && removed.length === 0) {
    log.debug(
      { toolsDir },
      "loadWorkspaceTools: no workspace tools registered or stripped",
    );
  } else {
    log.info(
      { count: registered.length, toolsDir, removedCount: removed.length },
      `Workspace tools reconciled: ${registered.length} registered${removed.length > 0 ? `, ${removed.length} core tool${removed.length === 1 ? "" : "s"} stripped` : ""}`,
    );
  }

  return { registered, removed };
}

/**
 * Test-only — drop the mtime cache and serialization chain so a fresh
 * test starts from a clean reconcile baseline. The registry itself is
 * reset separately via `__clearRegistryForTesting`.
 */
export function __resetWorkspaceToolCacheForTesting(): void {
  managed.clear();
  inflightReconcile = null;
}
