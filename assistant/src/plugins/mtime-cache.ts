/**
 * Per-surface mtime cache for user plugins (discovery + tools).
 *
 * Instead of caching whole `Plugin` objects, the user-plugin system caches
 * individual surfaces keyed by their source file's mtime. This module owns
 * plugin **discovery** (which plugin directories exist, in what order) and the
 * **tool** cache; the **hook** cache and every hook operation live in
 * `../hooks/hook-loader.ts`. This module is the boot orchestrator: it scans the
 * plugins directory, registers tools, and drives hook pre-import / init /
 * shutdown by handing the discovered directories to the hook loader.
 *
 * - A changed tool file triggers a re-import of just that tool, not a full
 *   plugin rebuild. Added and removed surface files are picked up live, since
 *   discovery is by directory listing.
 * - Plugins are never "registered" as a unit — we register their tools into
 *   the global tool registry and cache-bust them using mtime on reads.
 *
 * The cache is populated at boot by `loadUserPlugins()` and read on every
 * `getHooksFor` / `getAllTools` call.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { registerShutdownHook } from "../daemon/shutdown-registry.js";
import {
  clearPluginHooks,
  collectUserHooks,
  evictHooksForOwner,
  hasWorkspaceHooks,
  preImportHooksDir,
  preImportWorkspaceHooks,
  resetHookCacheForTests,
  runInitHook,
  runShutdownHook,
  WORKSPACE_HOOKS_OWNER,
} from "../hooks/hook-loader.js";
import { unregisterJobHandlersForOwner } from "../persistence/jobs-worker.js";
import type { HookFunction, ShutdownContext } from "../plugin-api/types.js";
import { reconcileBuiltinMemoryTools } from "../tools/memory/builtin-memory-tool-sync.js";
import {
  registerPluginTools,
  unregisterPluginTool,
  unregisterPluginTools,
} from "../tools/registry.js";
import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolDefinition } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import {
  deriveToolName,
  listSurfaceDir,
  parsePluginManifest,
} from "./external-plugin-loader.js";
import { shouldBuiltinMemoryYield } from "./memory-capability.js";
import {
  clearSurfaceImportInflight,
  getMtime,
  importWithTimeout,
  setSurfaceImportTimeout,
} from "./surface-import.js";

// Re-export for type compat — consumers that import HookFunction from
// the mtime cache module still resolve.
export type { HookFunction } from "./types.js";

const log = getLogger("plugin-mtime-cache");

/**
 * Cached install-date timestamps per plugin directory, so `scanPlugins`
 * doesn't re-read `install-meta.json` on every turn. Populated on first
 * discovery, cleared on eviction and in test reset. The install date
 * doesn't change during a process lifetime.
 */
const installDateCache = new Map<string, number>();

/**
 * The filename of the provenance sidecar written by the plugin install CLI.
 * We read only the `installedAt` field for ordering — the full `InstallMeta`
 * type lives in `src/cli/lib/install-from-github.ts` and we avoid pulling
 * the CLI dependency graph into the daemon.
 */
const INSTALL_META_FILENAME = "install-meta.json";

/**
 * Get a sortable timestamp for a plugin directory, used to order plugins
 * deterministically by their original install date.
 *
 * Resolution order:
 * 1. `install-meta.json` → `installedAt` field (ISO-8601 string → epoch ms)
 * 2. `statSync(pluginDir).birthtimeMs` (directory creation time as fallback)
 * 3. `Infinity` (unknown — sorts after all dated plugins)
 *
 * Results are cached in `installDateCache` so repeated `scanPlugins` calls
 * during a process lifetime don't re-read the sidecar.
 */
function getInstallDate(pluginDir: string): number {
  const cached = installDateCache.get(pluginDir);
  if (cached !== undefined) return cached;

  // Try install-meta.json first.
  const metaPath = join(pluginDir, INSTALL_META_FILENAME);
  if (existsSync(metaPath)) {
    try {
      const raw = JSON.parse(readFileSync(metaPath, "utf8"));
      if (
        typeof raw === "object" &&
        raw !== null &&
        typeof raw.installedAt === "string"
      ) {
        const parsed = Date.parse(raw.installedAt);
        if (!Number.isNaN(parsed)) {
          installDateCache.set(pluginDir, parsed);
          return parsed;
        }
      }
    } catch {
      // Malformed sidecar — fall through to birthtime.
    }
  }

  // Fall back to directory birthtime. On Linux ext4 and other filesystems
  // that don't support birth time, statSync returns 0 — treat that as
  // unknown so undated plugins sort after dated ones.
  let timestamp = Infinity;
  try {
    const birthtime = statSync(pluginDir).birthtimeMs;
    if (birthtime > 0) {
      timestamp = birthtime;
    }
  } catch {
    // statSync failed — leave as Infinity.
  }

  installDateCache.set(pluginDir, timestamp);
  return timestamp;
}

// ─── Cache entries ───────────────────────────────────────────────────────────

/**
 * A cached tool plus the mtime of its source file. When the on-disk mtime
 * changes, the tool is re-imported, the old tool is unregistered from the
 * global tool registry, and the new one is registered.
 */
interface CachedTool {
  readonly tool: Tool;
  /** mtimeMs of the source file this tool was imported from. */
  readonly sourceMtime: number;
  /** The plugin name that owns this tool (for unregister). */
  readonly pluginName: string;
}

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Cached tools keyed by `${pluginName}/${toolName}`. The key includes the
 * plugin name so tools from different plugins don't collide.
 */
const toolCache = new Map<string, CachedTool>();

/**
 * Plugin directories discovered at boot, in discovery order. Maps directory
 * path to the plugin's scope-stripped manifest name so eviction can find
 * the right cache key prefix without reading the (now-deleted) manifest.
 */
const discoveredPluginDirs = new Map<string, string>();

/**
 * Plugin directories that have a `.disabled` sentinel and were logged as
 * disabled. Tracked so we only emit the "plugin disabled" log line once
 * per scan cycle (the scan runs on every hook read). Cleared when a plugin
 * transitions back to active or is evicted entirely.
 */
const disabledPluginDirs = new Set<string>();

/**
 * Names of currently-discovered, enabled user plugins that declare
 * `vellum.provides === "memory"` in their `package.json`. Refreshed on every
 * `scanPlugins` so the set tracks live install/uninstall/disable transitions.
 * Read by the memory-capability arbiter (`plugins/memory-capability.ts`) to
 * decide whether the built-in memory plugins yield. `.disabled` plugins are
 * excluded — a disabled external memory plugin must not make the built-in yield.
 */
const memoryCapabilityPluginNames = new Set<string>();

/**
 * The yield decision (`shouldBuiltinMemoryYield()`) observed at the end of the
 * previous scan. The built-in `remember`/`recall` tools are reconciled whenever
 * this flips — not only when the discovered plugin-name set changes. The yield
 * decision also depends on the `memory-plugin-provider` feature flag, so a
 * runtime flag flip (with no plugin-set change) must still resync tool
 * ownership: otherwise the built-in hooks start yielding while the built-in core
 * tools stay registered, leaving hooks and tools owned by different parties
 * until a restart. `null` until the first scan establishes a baseline.
 */
let previousBuiltinMemoryYield: boolean | null = null;

/**
 * Names of currently-discovered, enabled user plugins that declare
 * `vellum.provides === "memory"`. The arbiter in `plugins/memory-capability.ts`
 * uses this to enforce the single-active-memory-plugin rule and to suppress the
 * built-in memory hooks when an external memory plugin is installed.
 */
export function getDiscoveredMemoryCapabilityPlugins(): string[] {
  return Array.from(memoryCapabilityPluginNames);
}

// ─── Hook reads ──────────────────────────────────────────────────────────────

/**
 * Get all hooks for a given event name from user plugins and standalone
 * workspace hooks. Refreshes plugin discovery first, then delegates the actual
 * hook resolution to the hook loader. Plugin hooks run in install-date order,
 * the workspace hook runs last.
 */
export async function getUserHooksFor<TCtx = unknown>(
  hookName: string,
): Promise<HookFunction<TCtx>[]> {
  await scanPlugins();
  return collectUserHooks<TCtx>(hookName, discoveredPluginDirs);
}

// ─── Tool cache ──────────────────────────────────────────────────────────────

/**
 * Cache key for a tool: `${pluginName}/${toolName}`.
 */
function toolKey(pluginName: string, toolName: string): string {
  return `${pluginName}/${toolName}`;
}

/**
 * Reconcile the tool cache for a single plugin directory. Re-imports
 * changed tool files, unregisters deleted tools, and registers new ones.
 *
 * Called during `scanPlugins()` so that by the time any consumer reads
 * the tool registry, the cache is fresh.
 */
async function reconcilePluginTools(
  pluginDir: string,
  pluginName: string,
): Promise<void> {
  const toolsDir = join(pluginDir, "tools");
  const surfaceFiles = listSurfaceDir(toolsDir);
  const onDiskNames = new Set<string>();

  for (const file of surfaceFiles) {
    const toolName = deriveToolName(file.name);
    onDiskNames.add(toolName);
    const key = toolKey(pluginName, toolName);
    const currentMtime = getMtime(file.path);

    // Cache hit — same mtime.
    const cached = toolCache.get(key);
    if (
      cached !== undefined &&
      cached.sourceMtime === currentMtime &&
      currentMtime > 0
    ) {
      continue;
    }

    // Cache miss — re-import.
    if (currentMtime === 0) {
      // File was deleted — will be handled by the eviction loop below.
      continue;
    }

    try {
      const toolSpec = await importWithTimeout<ToolDefinition>(file.path);
      if (
        toolSpec === undefined ||
        toolSpec === null ||
        typeof toolSpec !== "object"
      ) {
        log.error(
          { plugin: pluginName, tool: toolName, path: file.path },
          `tool default export must be an object — skipping`,
        );
        continue;
      }
      const tool = finalizeTool(toolSpec, toolName);
      toolCache.set(key, { tool, sourceMtime: currentMtime, pluginName });
    } catch (err) {
      log.error(
        { err, plugin: pluginName, tool: toolName, path: file.path },
        `Failed to import tool ${toolName} from ${file.path}`,
      );
    }
  }

  // Evict cached tools whose files no longer exist on disk.
  for (const key of toolCache.keys()) {
    const [cachedPluginName, cachedToolName] = key.split("/");
    if (cachedPluginName !== pluginName) continue;
    if (!onDiskNames.has(cachedToolName)) {
      toolCache.delete(key);
    }
  }
}

/**
 * Get all cached tools from user plugins. Called by the tool registry
 * to supplement the core + default plugin tools.
 */
export function getCachedUserTools(): Tool[] {
  return Array.from(toolCache.values()).map((c) => c.tool);
}

// ─── Plugin discovery ────────────────────────────────────────────────────────

/**
 * Scan the plugins directory, update the discovered set, and reconcile
 * tools for each plugin. Also evicts cache entries for deleted plugins.
 *
 * This is the "pull" — called on every hook read and at boot. The cost
 * is one `readdirSync` + N `statSync` calls where N = total surface files
 * across all plugins. For a typical workspace with 2-3 plugins, that's
 * ~10-15 stats — sub-millisecond.
 */
async function scanPlugins(): Promise<void> {
  const pluginsDir = getWorkspacePluginsDir();

  if (!existsSync(pluginsDir)) {
    // No plugins directory — evict everything.
    await evictAll();
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    log.warn({ pluginsDir }, "scanPlugins: failed to read plugins directory");
    return;
  }

  const currentDirs = new Map<string, string>();
  // Rebuilt fresh each scan from the enabled plugins discovered below, so a
  // disabled/removed external memory plugin drops out and the built-in stops
  // yielding to it.
  const currentMemoryCapabilityNames = new Set<string>();

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);
    try {
      if (!statSync(pluginDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(pluginDir, "package.json"))) continue;

    // Check for the .disabled sentinel. A plugin is disabled when a file
    // named `.disabled` exists inside its plugin directory. Disabled
    // plugins are skipped entirely — no hooks, no tools, no cache entries.
    // If the plugin was previously active, its cache entries are evicted.
    if (existsSync(join(pluginDir, ".disabled"))) {
      const manifest = await parsePluginManifest(pluginDir);
      const pluginName = manifest?.name ?? entry;
      if (discoveredPluginDirs.has(pluginDir)) {
        await deactivatePlugin(pluginName);
        await evictPlugin(pluginDir, pluginName);
      }
      if (!disabledPluginDirs.has(pluginDir)) {
        log.info(
          { plugin: pluginName, pluginDir },
          "plugin disabled via .disabled sentinel — skipping",
        );
        disabledPluginDirs.add(pluginDir);
      }
      continue;
    }

    const manifest = await parsePluginManifest(pluginDir);
    if (manifest === undefined) continue;
    const { name: pluginName } = manifest;

    currentDirs.set(pluginDir, pluginName);
    disabledPluginDirs.delete(pluginDir);
    if (manifest.provides === "memory") {
      currentMemoryCapabilityNames.add(pluginName);
    }

    if (!discoveredPluginDirs.has(pluginDir)) {
      log.info({ plugin: pluginName, pluginDir }, "plugin discovered");
    }

    // Reconcile this plugin's tools (re-imports changed files).
    await reconcilePluginTools(pluginDir, pluginName);
  }

  // Deactivate and evict cache entries for deleted plugins.
  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    if (!currentDirs.has(pluginDir)) {
      await deactivatePlugin(pluginName);
      await evictPlugin(pluginDir, pluginName);
    }
  }

  // Update the discovered set, sorted by original install date so
  // hook execution order and tool registration order are deterministic.
  discoveredPluginDirs.clear();
  const sorted = [...currentDirs.entries()].sort(
    ([dirA], [dirB]) => getInstallDate(dirA) - getInstallDate(dirB),
  );
  for (const [dir, name] of sorted) {
    discoveredPluginDirs.set(dir, name);
  }

  // Swap in the freshly-computed memory-capability set so a disabled or removed
  // external memory plugin stops suppressing the built-in memory hooks.
  const memoryCapabilitySetChanged = !sameStringSet(
    memoryCapabilityPluginNames,
    currentMemoryCapabilityNames,
  );
  memoryCapabilityPluginNames.clear();
  for (const name of currentMemoryCapabilityNames) {
    memoryCapabilityPluginNames.add(name);
  }

  // Resync the built-in `remember`/`recall` tools BEFORE activating plugins
  // below whenever tool ownership could lag the live yield decision:
  //
  // - the discovered memory-capability set changed (an external memory plugin
  //   was installed/removed/disabled), or
  // - the yield decision itself flipped without a set change — most notably a
  //   runtime `memory-plugin-provider` flag flip, which toggles whether an
  //   already-installed memory plugin's hooks suppress the built-in.
  //
  // Reconciling here keeps hooks and tools switching owners together: if an
  // external memory plugin is (now) active, the built-in core tools are stripped
  // first so the plugin's same-named tools register cleanly on activation; if it
  // is no longer active, the built-in tools are re-registered. This mirrors how
  // the built-in memory hooks already yield at read time, without a restart.
  const currentBuiltinMemoryYield = shouldBuiltinMemoryYield();
  const yieldDecisionChanged =
    previousBuiltinMemoryYield === null ||
    previousBuiltinMemoryYield !== currentBuiltinMemoryYield;
  previousBuiltinMemoryYield = currentBuiltinMemoryYield;
  if (memoryCapabilitySetChanged || yieldDecisionChanged) {
    reconcileBuiltinMemoryTools();
  }

  // Activate any plugin not yet brought up. Idempotent: already-active plugins
  // are skipped by the `activatedNames` guard, so steady-state scans (one per
  // hook dispatch) cost only a membership check per plugin. Tools were imported
  // into `toolCache` by `reconcilePluginTools` above, so they are ready to
  // register here.
  for (const [dir, name] of discoveredPluginDirs) {
    await activatePlugin(dir, name);
  }
}

/** Whether two string sets contain exactly the same members. */
function sameStringSet(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/**
 * Evict all cache entries for a deleted plugin directory. The plugin name
 * is passed in from the discoveredPluginDirs map (captured when the plugin
 * was last scanned), so we don't need to read the now-deleted manifest.
 */
async function evictPlugin(
  pluginDir: string,
  pluginName: string,
): Promise<void> {
  // Evict hooks (owned by the hook loader).
  evictHooksForOwner(pluginName);

  // Evict tools.
  const toolPrefix = `${pluginName}/`;
  for (const key of toolCache.keys()) {
    if (key.startsWith(toolPrefix)) {
      toolCache.delete(key);
    }
  }

  log.info(
    { plugin: pluginName, pluginDir },
    "plugin evicted (directory removed)",
  );
  discoveredPluginDirs.delete(pluginDir);
  installDateCache.delete(pluginDir);
}

/**
 * Evict all plugin-owned cache entries (when the plugins directory is gone
 * entirely). Standalone workspace hooks are preserved by the hook loader:
 * they live outside the plugins directory, so the absence of any plugin must
 * not evict them.
 */
async function evictAll(): Promise<void> {
  // If an external memory plugin was active (or the built-in was yielding) and
  // the entire plugins directory then vanished, the built-in must reclaim the
  // `remember`/`recall` tools — otherwise its hooks stop yielding (the set is
  // now empty) while its core tools stay stripped, splitting hook and tool
  // ownership until a restart. Detect that BEFORE clearing the set.
  const hadActiveMemoryPlugin = memoryCapabilityPluginNames.size > 0;

  clearPluginHooks();
  toolCache.clear();
  registeredFileToolNames.clear();
  discoveredPluginDirs.clear();
  installDateCache.clear();
  disabledPluginDirs.clear();
  memoryCapabilityPluginNames.clear();

  if (hadActiveMemoryPlugin || previousBuiltinMemoryYield === true) {
    // The set is now empty, so `shouldBuiltinMemoryYield()` is false and this
    // re-registers the built-in memory tools.
    reconcileBuiltinMemoryTools();
  }
  previousBuiltinMemoryYield = shouldBuiltinMemoryYield();
}

// ─── Activation lifecycle ────────────────────────────────────────────────────

/**
 * Plugins (and the workspace-hooks pseudo-owner) fully activated (tools
 * registered + `init` hook run) within this process, in activation order. The
 * process shutdown hook walks this list in reverse to tear everything down.
 */
const activatedPlugins: Array<{ name: string }> = [];

/**
 * Names in {@link activatedPlugins}, kept as a set for O(1) membership and —
 * critically — reserved *synchronously* at the top of `activatePlugin`. The
 * per-turn hook dispatch reaches `scanPlugins` on every turn (sometimes
 * concurrently), so the synchronous reservation is what prevents a second scan
 * from double-activating a plugin while its async `init()` is still in flight.
 */
const activatedNames = new Set<string>();

const shutdownContext: ShutdownContext = {
  assistantVersion: APP_VERSION,
};

/** A plugin's currently-cached tools, in cache order. */
function cachedToolsFor(pluginName: string): Tool[] {
  return Array.from(toolCache.values())
    .filter((c) => c.pluginName === pluginName)
    .map((c) => c.tool);
}

/**
 * Names of the file-backed tools this module last registered into the global
 * registry per plugin. Tracked so an already-active plugin's runtime tool
 * delta is unambiguous: a name that was here last scan but is gone from the
 * cache this scan is a deleted `tools/*.ts` file and must be unregistered,
 * while a name a plugin contributed through `host.registries.registerTools()`
 * (never file-backed, so never recorded here) is left untouched. Cleared on
 * deactivation/eviction and in test reset.
 */
const registeredFileToolNames = new Map<string, Set<string>>();

/**
 * Register the plugin's file-backed tool cache into the global registry and
 * record the names that actually landed in {@link registeredFileToolNames}.
 * Shared by first activation and the already-active reconcile so the tracked
 * set always mirrors what this module owns in the registry. Returns the
 * registered names (post provider-safe aliasing), or `[]` on failure.
 *
 * The tracked set is REPLACED with the accepted names rather than unioned: a
 * cached tool that `registerPluginTools` skips (e.g. its name was reclaimed as
 * a core tool when the built-in memory provider stopped yielding) drops out of
 * the set, so the next scan won't try to unregister a tool this module no
 * longer owns.
 */
function registerCachedToolsForPlugin(
  pluginName: string,
  cachedTools: Tool[],
): string[] {
  if (cachedTools.length === 0) {
    registeredFileToolNames.set(pluginName, new Set());
    return [];
  }
  try {
    const registeredNames = registerPluginTools(pluginName, cachedTools).map(
      (t) => t.name,
    );
    registeredFileToolNames.set(pluginName, new Set(registeredNames));
    return registeredNames;
  } catch (err) {
    log.error(
      { err, plugin: pluginName },
      `Failed to register tools for user plugin ${pluginName}`,
    );
    return [];
  }
}

/**
 * Push the plugin's freshly-imported tool cache into the global registry for
 * an ALREADY-ACTIVE plugin, so a runtime tool change reaches the live tool
 * surface without a disable/enable cycle or daemon restart.
 *
 * `reconcilePluginTools` (run earlier in the scan) keeps `toolCache` current —
 * it re-imports changed `tools/*.ts` files, drops cache entries whose files
 * were deleted, and adds entries for new files. But for a plugin already past
 * `activatePlugin`, those cache mutations never reach the global registry,
 * which was populated once at activation. This reconciles the registry to the
 * cache by applying just the delta:
 *
 * - tools present in the cache are (re-)registered, which adds new files and
 *   overwrites changed ones; the registry's same-definition short-circuit
 *   makes an unchanged tool a no-op;
 * - file-backed tools this module registered last scan but that no longer land
 *   (a deleted `tools/*.ts` file, or a name reclaimed by the built-in memory
 *   provider when it stopped yielding) are unregistered.
 *
 * The removal set is the difference between the names this module had
 * registered before this scan and the names it just registered — both in the
 * provider-safe registered-name namespace, captured from `registerPluginTools`
 * itself, so the diff is exact regardless of name aliasing. Tools a plugin
 * contributed through `host.registries.registerTools()` are not file-backed,
 * so they never enter `toolCache` nor {@link registeredFileToolNames}; the
 * removal side cannot strip them, and the registration side never touches them.
 *
 * Steady-state (nothing changed on disk) is a no-op: the before/after
 * registered-name sets are equal, and every cached tool is the same instance
 * already registered.
 */
function reconcileActivePluginRegistry(pluginName: string): void {
  const before = new Set(registeredFileToolNames.get(pluginName) ?? []);
  // Re-register the cache; this replaces the tracked set with the names that
  // actually landed (skipping any reclaimed as core tools).
  registerCachedToolsForPlugin(pluginName, cachedToolsFor(pluginName));
  const after = registeredFileToolNames.get(pluginName) ?? new Set<string>();
  for (const name of before) {
    if (!after.has(name)) {
      unregisterPluginTool(pluginName, name);
    }
  }
}

/**
 * Activate a single discovered plugin: pre-import its hooks, register its tools
 * into the global tool registry, and run its `init` hook. Idempotent — a plugin
 * already activated (or mid-activation) reconciles its tool cache into the live
 * registry (so runtime tool add/delete and built-in memory flag flips land
 * without a restart) and otherwise does no re-init. Never throws; per-surface
 * failures are logged and the plugin still counts as activated so the shutdown
 * hook tears down whatever came up (mirrors boot semantics).
 *
 * Called from `scanPlugins`, which runs both at boot and on every subsequent
 * scan — so a plugin whose files appear at runtime (installed via the CLI or
 * provisioned out-of-band) becomes live without a daemon restart.
 */
async function activatePlugin(
  pluginDir: string,
  pluginName: string,
): Promise<void> {
  if (activatedNames.has(pluginName)) {
    // Already brought up: keep the live registry in step with the plugin's
    // tool cache, which `reconcilePluginTools` refreshed earlier in this scan.
    reconcileActivePluginRegistry(pluginName);
    return;
  }
  // Reserve synchronously, before any await, so a re-entrant or concurrent
  // scan observes this plugin as already handled.
  activatedNames.add(pluginName);

  // Pre-import all hooks so the first dispatch doesn't pay the import cost.
  await preImportHooksDir(join(pluginDir, "hooks"), pluginName);

  // Register this plugin's tools into the global tool registry so
  // `getAllTools()` and `getTool()` can find them. Tools were already imported
  // and cached by `reconcilePluginTools` during the scan. Records the
  // registered names so subsequent scans can diff a runtime tool delta.
  const registered = registerCachedToolsForPlugin(
    pluginName,
    cachedToolsFor(pluginName),
  );
  if (registered.length > 0) {
    log.info(
      { plugin: pluginName, count: registered.length },
      "user plugin tools registered",
    );
  }

  // Run the `init` hook if present.
  await runInitHook(pluginName, pluginDir);

  activatedPlugins.push({ name: pluginName });
}

/**
 * Deactivate a plugin whose directory was removed or disabled at runtime:
 * unregister its tools and run its `shutdown` hook. Must run *before*
 * `evictPlugin` clears the hook cache, since the shutdown hook is read from it.
 * Idempotent — a plugin that was never activated is a no-op.
 */
async function deactivatePlugin(pluginName: string): Promise<void> {
  if (!activatedNames.has(pluginName)) return;
  activatedNames.delete(pluginName);
  const idx = activatedPlugins.findIndex((p) => p.name === pluginName);
  if (idx >= 0) activatedPlugins.splice(idx, 1);

  // Unregister tools before running shutdown so the model-visible surface is
  // clean before teardown. One call fully removes the plugin's tools (no
  // refcount gate), including any registered through a `host.registries` facet
  // call in addition to its `tools/*.ts` files.
  try {
    unregisterPluginTools(pluginName);
  } catch (err) {
    log.warn(
      { err, plugin: pluginName },
      "user plugin tool unregister failed (continuing)",
    );
  }
  registeredFileToolNames.delete(pluginName);

  // Remove the plugin's background-job handlers so a pending `plugin:<id>:` job
  // cannot dispatch into the torn-down plugin's code after it is disabled or
  // removed at runtime. Scoped by the plugin's namespace, so core handlers are
  // untouched.
  try {
    unregisterJobHandlersForOwner(pluginName);
  } catch (err) {
    log.warn(
      { err, plugin: pluginName },
      "user plugin job-handler unregister failed (continuing)",
    );
  }

  await runShutdownHook(pluginName, shutdownContext, "plugin-removed");
}

// ─── Boot population ─────────────────────────────────────────────────────────

/**
 * Populate the caches at boot by scanning the plugins directory once (which
 * imports surfaces, registers tools, and runs `init` hooks via `activatePlugin`
 * inside `scanPlugins`), activating standalone workspace hooks, and installing
 * the process shutdown hook.
 *
 * This replaces the old `loadExternalPlugin` → `registerPlugin` →
 * `bootstrapPlugins` path for user plugins. Instead of registering whole
 * `Plugin` objects into the plugin registry, we register individual tools into
 * the tool registry and cache hooks by mtime.
 *
 * Called by `loadUserPlugins()` during daemon startup. After boot, the same
 * `scanPlugins` → `activatePlugin`/`deactivatePlugin` reconciliation runs on
 * every turn via `getUserHooksFor` (plugin hook dispatch), so plugins whose
 * files appear or disappear at runtime are picked up without a restart.
 */
export async function populateCacheAtBoot(
  opts: { importTimeoutMs?: number } = {},
): Promise<void> {
  if (opts.importTimeoutMs !== undefined) {
    setSurfaceImportTimeout(opts.importTimeoutMs);
  }

  // Scans + activates every discovered plugin (tools registered + `init` run).
  await scanPlugins();

  // Activate standalone workspace hooks under `<workspace>/hooks/`. These
  // carry no package.json, no tools, and no install-date ordering — just hook
  // files. Pre-import them and run their `init` hook so a workspace-wide
  // `init`/`shutdown` lifecycle works the same way a plugin's does. Only
  // register for teardown when at least one hook file is actually present, so
  // an empty/absent directory adds no shutdown work.
  if (hasWorkspaceHooks()) {
    await preImportWorkspaceHooks();
    await runInitHook(WORKSPACE_HOOKS_OWNER);
    activatedPlugins.push({ name: WORKSPACE_HOOKS_OWNER });
  }

  // Register a single shutdown hook that walks all activated owners in reverse
  // order, unregistering tools and running shutdown hooks. It reads the live
  // `activatedPlugins` array at teardown time, so plugins activated after boot
  // (runtime installs) are torn down too.
  registerShutdownHook("user-plugins", async (reason) => {
    for (let i = activatedPlugins.length - 1; i >= 0; i--) {
      const entry = activatedPlugins[i];
      if (entry === undefined) continue;
      const { name } = entry;

      // Unregister tools before running shutdown so onShutdown sees a
      // clean model-visible surface. (No-op for the workspace-hooks owner,
      // which registers no tools.)
      try {
        unregisterPluginTools(name);
      } catch (err) {
        log.warn(
          { err, plugin: name, reason },
          "user plugin tool unregister failed (continuing)",
        );
      }
      registeredFileToolNames.delete(name);

      // Run the `shutdown` hook if present.
      await runShutdownHook(name, shutdownContext, reason);
    }
  });
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

/**
 * Clear all caches. Test-only.
 */
export function resetPluginCacheForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "resetPluginCacheForTests may only be called in test environments",
    );
  }
  resetHookCacheForTests();
  clearSurfaceImportInflight();
  toolCache.clear();
  registeredFileToolNames.clear();
  discoveredPluginDirs.clear();
  installDateCache.clear();
  activatedPlugins.length = 0;
  activatedNames.clear();
  disabledPluginDirs.clear();
  memoryCapabilityPluginNames.clear();
  previousBuiltinMemoryYield = null;
}

/**
 * Test-only: inspect the tool cache.
 */
export function _inspectToolCacheForTests(): Array<{
  key: string;
  sourceMtime: number;
}> {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "_inspectToolCacheForTests may only be called in test environments",
    );
  }
  return Array.from(toolCache.entries()).map(([key, c]) => ({
    key,
    sourceMtime: c.sourceMtime,
  }));
}
