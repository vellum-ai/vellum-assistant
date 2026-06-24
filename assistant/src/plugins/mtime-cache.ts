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
import type {
  PluginHookFn,
  PluginShutdownContext,
} from "../plugin-api/types.js";
import {
  registerPluginTools,
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
import {
  clearSurfaceImportInflight,
  getMtime,
  importWithTimeout,
  setSurfaceImportTimeout,
} from "./surface-import.js";

// Re-export for type compat — consumers that import PluginHookFn from
// the mtime cache module still resolve.
export type { PluginHookFn } from "./types.js";

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

// ─── Hook reads ──────────────────────────────────────────────────────────────

/**
 * Get all hooks for a given event name from user plugins and standalone
 * workspace hooks. Refreshes plugin discovery first, then delegates the actual
 * hook resolution to the hook loader. Plugin hooks run in install-date order,
 * the workspace hook runs last.
 */
export async function getUserHooksFor<TCtx = unknown>(
  hookName: string,
): Promise<PluginHookFn<TCtx>[]> {
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

    if (!discoveredPluginDirs.has(pluginDir)) {
      log.info({ plugin: pluginName, pluginDir }, "plugin discovered");
    }

    // Reconcile this plugin's tools (re-imports changed files).
    await reconcilePluginTools(pluginDir, pluginName);
  }

  // Evict cache entries for deleted plugins.
  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    if (!currentDirs.has(pluginDir)) {
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
  clearPluginHooks();
  toolCache.clear();
  discoveredPluginDirs.clear();
  installDateCache.clear();
  disabledPluginDirs.clear();
}

// ─── Boot population ─────────────────────────────────────────────────────────

/**
 * Plugins (and the workspace-hooks pseudo-owner) that were fully activated at
 * boot (tools registered + init hook run). Used by the shutdown hook to tear
 * down only what was actually brought up.
 */
const activatedPlugins: Array<{ name: string }> = [];

/**
 * Populate the caches at boot by scanning the plugins directory once,
 * importing all surfaces, registering tools into the tool registry,
 * running `init` hooks, and installing a shutdown hook.
 *
 * This replaces the old `loadExternalPlugin` → `registerPlugin` →
 * `bootstrapPlugins` path for user plugins. Instead of registering whole
 * `Plugin` objects into the plugin registry, we register individual tools
 * into the tool registry and cache hooks by mtime. The `init` and
 * `shutdown` hooks are still run exactly once per boot, preserving the
 * activation lifecycle that plugins rely on.
 *
 * Called by `loadUserPlugins()` during daemon startup.
 */
export async function populateCacheAtBoot(
  opts: { importTimeoutMs?: number } = {},
): Promise<void> {
  if (opts.importTimeoutMs !== undefined) {
    setSurfaceImportTimeout(opts.importTimeoutMs);
  }

  await scanPlugins();

  const shutdownContext: PluginShutdownContext = {
    assistantVersion: APP_VERSION,
  };

  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    // Pre-import all hooks so the first turn doesn't pay the import cost.
    await preImportHooksDir(join(pluginDir, "hooks"), pluginName);

    // Register user plugin tools into the global tool registry so
    // `getAllTools()` and `getTool()` can find them. Tools were already
    // imported and cached by `reconcilePluginTools` during `scanPlugins`.
    const pluginTools = Array.from(toolCache.values())
      .filter((c) => c.pluginName === pluginName)
      .map((c) => c.tool);
    if (pluginTools.length > 0) {
      try {
        registerPluginTools(pluginName, pluginTools);
        log.info(
          { plugin: pluginName, count: pluginTools.length },
          "user plugin tools registered",
        );
      } catch (err) {
        log.error(
          { err, plugin: pluginName },
          `Failed to register tools for user plugin ${pluginName}`,
        );
      }
    }

    // Run the `init` hook if present.
    await runInitHook(pluginName);

    activatedPlugins.push({ name: pluginName });
  }

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
  // order, unregistering tools and running shutdown hooks.
  const shutdownSnapshot = [...activatedPlugins];
  registerShutdownHook("user-plugins", async (reason) => {
    for (let i = shutdownSnapshot.length - 1; i >= 0; i--) {
      const { name } = shutdownSnapshot[i]!;

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
  discoveredPluginDirs.clear();
  installDateCache.clear();
  activatedPlugins.length = 0;
  disabledPluginDirs.clear();
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
