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
 *         → start file watcher       ← hot register/unregister (no restart)
 *
 * Plugins load *after* the initial workspace-tool scan so the registry
 * hands them a stable view of which workspace tools exist before any
 * plugin code runs. The file watcher then runs for the lifetime of the
 * assistant, picking up add/change/delete events to keep the registry
 * in sync with disk.
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
import { pathToFileURL } from "node:url";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceToolsDir } from "../../util/platform.js";
import { isProviderSafeToolName } from "../provider-tool-name.js";
import { registerWorkspaceTools, removeCoreToolViaWorkspace } from "../registry.js";
import { finalizeTool } from "../tool-defaults.js";
import type {
  RiskLevel,
  Tool,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

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
  if (stem.length === 0) return false;
  if (stem.startsWith(".")) return false;
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
): { kind: "live"; stem: string; ext: LiveToolExtension } | { kind: "removed"; stem: string } | undefined {
  const ext = extname(entry);
  if (ext === REMOVED_EXTENSION) {
    return { kind: "removed", stem: entry.slice(0, -REMOVED_EXTENSION.length) };
  }
  for (const candidate of LIVE_TOOL_EXTENSIONS) {
    if (ext === candidate) {
      return { kind: "live", stem: entry.slice(0, -candidate.length), ext: candidate };
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

function selectLiveExtension(extensions: Set<LiveToolExtension>): LiveSelection {
  for (const candidate of LIVE_TOOL_EXTENSIONS) {
    if (extensions.has(candidate)) {
      const shadowed: LiveToolExtension[] = [];
      for (const ext of LIVE_TOOL_EXTENSIONS) {
        if (ext !== candidate && extensions.has(ext)) shadowed.push(ext);
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
 */
function applyWorkspaceToolDefaults(
  tool: ToolDefinition,
  name: string,
): Tool {
  const finalized = finalizeTool(
    {
      ...tool,
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
 * A cache-busting `?v=<counter>` query string is appended so the loader's
 * later re-imports (driven by the file watcher) pick up disk changes
 * instead of node's cached module. The counter is per-call, so every
 * import gets a fresh module identity.
 *
 * All failure paths log with file attribution so operators can find the
 * broken tool quickly.
 */
let importCounter = 0;

async function importToolDefaultBounded(
  entryPath: string,
  timeoutMs: number,
): Promise<unknown> {
  const url = `${pathToFileURL(entryPath).href}?v=${++importCounter}`;
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
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
async function readJsonToolSpec(entryPath: string): Promise<ToolDefinition | undefined> {
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
 * Result of a {@link loadWorkspaceTools} call — exposes which tool names
 * were registered and which were stripped so callers (notably the file
 * watcher) can compute deltas against subsequent re-scans.
 */
export interface LoadWorkspaceToolsResult {
  /** Tool names successfully registered as workspace tools. */
  readonly registered: string[];
  /** Tool names stripped from the registry via `<name>.removed` sentinels. */
  readonly removed: string[];
}

/**
 * Scan `<workspaceDir>/tools/` and register every well-formed
 * `<name>.{ts,js,json}` as a workspace tool. Files matching
 * `<name>.removed` strip the core tool of that name from the registry
 * via {@link removeCoreToolViaWorkspace}.
 *
 * Invariants:
 *
 * - No-ops silently when the tools directory does not exist. A clean
 *   install with zero workspace tools must produce no log noise beyond
 *   the eventual "0 workspace tools registered" debug line.
 * - Per-tool isolation: any single broken tool is logged and skipped
 *   without aborting the scan. The function resolves normally even when
 *   every candidate fails.
 * - Idempotency is the registry's job: a second call without a
 *   preceding unregister will throw on the duplicate-workspace-tool
 *   check. Callers (daemon startup) are expected to call once; the file
 *   watcher uses the per-event entry points instead.
 *
 * Caller responsibilities:
 *
 * - Must be invoked between {@link initializeTools} and
 *   {@link loadUserPlugins}. Calling earlier risks racing core
 *   registrations; calling later means plugins see an incomplete
 *   registry and may register over a name a workspace tool will later
 *   try to own.
 */
export async function loadWorkspaceTools(
  options: LoadWorkspaceToolsOptions = {},
): Promise<LoadWorkspaceToolsResult> {
  const importTimeoutMs = options.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
  const toolsDir = getWorkspaceToolsDir();

  if (!existsSync(toolsDir)) {
    log.debug({ toolsDir }, "Workspace tools directory does not exist — skipping");
    return { registered: [], removed: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(toolsDir);
  } catch (err) {
    log.warn(
      { err, toolsDir },
      "loadWorkspaceTools: failed to read tools directory — continuing with no workspace tools",
    );
    return { registered: [], removed: [] };
  }

  // Group entries by stem so we can detect multi-extension shadowing
  // (e.g. `foo.ts` + `foo.js` claiming the same name) before we kick off
  // any imports. Each stem maps to a Set of extensions; .removed sentinels
  // are tracked in a separate set since they're mutually exclusive with
  // live tool files (you don't strip AND register a name at once).
  const liveByStem = new Map<string, Set<LiveToolExtension>>();
  const removedStems = new Set<string>();

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
    if (!classified) continue;
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
      extensions = new Set<LiveToolExtension>();
      liveByStem.set(classified.stem, extensions);
    }
    extensions.add(classified.ext);
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

  // Apply removals before registrations so the batch validation in
  // registerWorkspaceTools sees the post-removal registry state.
  const removed: string[] = [];
  for (const stem of removedStems) {
    try {
      removeCoreToolViaWorkspace(stem);
      removed.push(stem);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, stem },
        `loadWorkspaceTools: failed to strip core tool "${stem}": ${message}`,
      );
    }
  }

  // Resolve each live stem to its winning entry, import it, and add to
  // the registration batch. Multi-extension shadowing warns once per
  // ignored sibling so the operator can clean up the redundant file.
  const batch: Array<{ tool: Tool; workspacePath: string }> = [];

  for (const [stem, extensions] of liveByStem) {
    const { ext: winningExt, shadowed } = selectLiveExtension(extensions);
    if (shadowed.length > 0) {
      log.warn(
        { stem, winningExt, shadowed, toolsDir },
        `loadWorkspaceTools: "${stem}" has multiple files (${[winningExt, ...shadowed].join(", ")}) — using ${winningExt} and ignoring the rest`,
      );
    }
    const entryPath = join(toolsDir, `${stem}${winningExt}`);

    let toolSpec: ToolDefinition | undefined;
    if (winningExt === ".json") {
      toolSpec = await readJsonToolSpec(entryPath);
    } else {
      const defaultExport = await importToolDefaultBounded(entryPath, importTimeoutMs);
      if (defaultExport === undefined) continue; // Failure already logged.
      if (defaultExport === null || typeof defaultExport !== "object") {
        log.error(
          { entryPath, type: typeof defaultExport },
          `Workspace tool at ${entryPath} default export must be an object — skipping`,
        );
        continue;
      }
      toolSpec = defaultExport as ToolDefinition;
    }
    if (!toolSpec) continue;

    const loaded = applyWorkspaceToolDefaults(toolSpec, stem);
    batch.push({ tool: loaded, workspacePath: entryPath });
  }

  if (batch.length === 0) {
    if (removed.length === 0) {
      log.debug(
        { toolsDir },
        "loadWorkspaceTools: no workspace tools to register or strip",
      );
    } else {
      log.info(
        { toolsDir, removedCount: removed.length, removed },
        `Stripped ${removed.length} core tool${removed.length === 1 ? "" : "s"} via workspace .removed sentinels`,
      );
    }
    return { registered: [], removed };
  }

  try {
    const accepted = registerWorkspaceTools(batch);
    log.info(
      { count: accepted.length, toolsDir, removedCount: removed.length },
      `Registered ${accepted.length} workspace tool${accepted.length === 1 ? "" : "s"}${removed.length > 0 ? ` (and stripped ${removed.length} core tool${removed.length === 1 ? "" : "s"})` : ""}`,
    );
    return { registered: accepted.map((t) => t.name), removed };
  } catch (err) {
    // A throw from registerWorkspaceTools means a hard conflict (e.g.
    // duplicate name in batch, lifecycle-order regression). The batch
    // validation phase guarantees no partial application landed, so
    // every workspace tool from this load attempt is absent from the
    // registry. Surface the error loudly but do NOT rethrow — assistant
    // startup must still complete.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, toolsDir, batchSize: batch.length },
      `loadWorkspaceTools: registry rejected batch — ${message}`,
    );
    return { registered: [], removed };
  }
}

// ─── Single-entry helpers for the file watcher ───────────────────────────────
//
// The watcher calls these on each fs event. The initial-scan path
// ({@link loadWorkspaceTools}) batches for transactional registration;
// the per-event path takes the simpler one-tool-at-a-time route since
// fs events arrive serially and the registry handles each as an
// atomic operation.

/**
 * Load and register a single workspace tool file. Returns the registered
 * tool name on success or `undefined` if the file failed to load (errors
 * are logged with file attribution and never thrown to the caller).
 *
 * Used by the file watcher's `add` event. The caller is expected to
 * have already unregistered any prior workspace tool for the same name.
 */
export async function loadSingleWorkspaceTool(
  entryPath: string,
  options: LoadWorkspaceToolsOptions = {},
): Promise<string | undefined> {
  const importTimeoutMs = options.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
  const filename = entryPath.split("/").pop() ?? "";
  const classified = classifyEntry(filename);
  if (!classified || classified.kind !== "live") {
    log.debug(
      { entryPath },
      "loadSingleWorkspaceTool: file is not a live tool entry — skipping",
    );
    return undefined;
  }
  if (!isValidToolFilenameStem(classified.stem)) {
    log.error(
      { entryPath, stem: classified.stem },
      `loadSingleWorkspaceTool: filename stem "${classified.stem}" is not a provider-safe tool name — skipping`,
    );
    return undefined;
  }

  let toolSpec: ToolDefinition | undefined;
  if (classified.ext === ".json") {
    toolSpec = await readJsonToolSpec(entryPath);
  } else {
    const defaultExport = await importToolDefaultBounded(entryPath, importTimeoutMs);
    if (defaultExport === undefined) return undefined;
    if (defaultExport === null || typeof defaultExport !== "object") {
      log.error(
        { entryPath, type: typeof defaultExport },
        `Workspace tool at ${entryPath} default export must be an object — skipping`,
      );
      return undefined;
    }
    toolSpec = defaultExport as ToolDefinition;
  }
  if (!toolSpec) return undefined;

  const loaded = applyWorkspaceToolDefaults(toolSpec, classified.stem);
  try {
    registerWorkspaceTools([{ tool: loaded, workspacePath: entryPath }]);
    return classified.stem;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, entryPath },
      `loadSingleWorkspaceTool: registry rejected "${classified.stem}": ${message}`,
    );
    return undefined;
  }
}

/**
 * Classify a single filesystem entry. Exposed for the file watcher so
 * it can route events without re-implementing the extension logic.
 */
export function classifyWorkspaceToolEntry(
  filename: string,
):
  | { kind: "live"; stem: string; ext: LiveToolExtension }
  | { kind: "removed"; stem: string }
  | undefined {
  return classifyEntry(filename);
}

/**
 * Scan `toolsDir` for all entries matching `stem` and return the winning
 * live file's absolute path (if any) plus whether a `.removed` sentinel
 * exists for the same stem.
 *
 * Multi-extension precedence: `.js` > `.ts` > `.json`. Shadowed siblings
 * are not reported here — the caller decides whether to warn (the full
 * scan path does; the per-stem watcher does not, because shadow events
 * are noisy in editor save flows).
 */
export function findWinningWorkspaceToolPath(
  toolsDir: string,
  stem: string,
): { livePath: string | null; liveExt: LiveToolExtension | null; hasRemovedSentinel: boolean } {
  if (!existsSync(toolsDir)) {
    return { livePath: null, liveExt: null, hasRemovedSentinel: false };
  }
  let entries: string[];
  try {
    entries = readdirSync(toolsDir);
  } catch (err) {
    log.warn(
      { err, toolsDir, stem },
      "findWinningWorkspaceToolPath: failed to read tools directory",
    );
    return { livePath: null, liveExt: null, hasRemovedSentinel: false };
  }

  const liveExtensions = new Set<LiveToolExtension>();
  let hasRemovedSentinel = false;

  for (const entry of entries) {
    const classified = classifyEntry(entry);
    if (!classified || classified.stem !== stem) continue;
    if (classified.kind === "removed") {
      hasRemovedSentinel = true;
    } else {
      liveExtensions.add(classified.ext);
    }
  }

  if (liveExtensions.size === 0) {
    return { livePath: null, liveExt: null, hasRemovedSentinel };
  }
  const { ext } = selectLiveExtension(liveExtensions);
  return {
    livePath: join(toolsDir, `${stem}${ext}`),
    liveExt: ext,
    hasRemovedSentinel,
  };
}
