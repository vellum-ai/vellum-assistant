/**
 * Per-surface mtime cache for user plugins.
 *
 * Instead of caching whole `Plugin` objects, this module caches individual
 * hooks and tools keyed by their source file's mtime. This means:
 *
 * - A changed hook file triggers a re-import of just that hook, not a full
 *   plugin rebuild.
 * - The same machinery extends to workspace-driven hooks and tools in the
 *   future (PR B), since each surface is cached independently.
 * - Plugins are never "registered" as a unit — we just register their tools
 *   and hooks into the global registries, then cache-bust them using mtime
 *   on reads.
 *
 * The cache is populated at boot by `loadUserPlugins()` and read on every
 * `getHooksFor` / `getAllTools` call. When a surface file's mtime changes,
 * the next read detects the mismatch, re-imports the file, and swaps the
 * cached entry.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { registerShutdownHook } from "../daemon/shutdown-registry.js";
import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginHookFn,
  PluginInitContext,
  PluginShutdownContext,
} from "../plugin-api/types.js";
import {
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolDefinition } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspacePluginsDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import {
  deriveToolName,
  importDefault,
  listSurfaceDir,
  parsePluginManifest,
} from "./external-plugin-loader.js";

// Re-export for type compat — consumers that import PluginHookFn from
// the mtime cache module still resolve.
export type { PluginHookFn } from "./types.js";

const log = getLogger("plugin-mtime-cache");

/**
 * Import timeout for surface file imports. Set by `populateCacheAtBoot` from
 * the value passed by `loadUserPlugins`, and used by `getUserHooksFor` and
 * `reconcilePluginTools` for runtime re-imports. Defaults to 10s.
 */
let importTimeoutMs = 10_000;

// ─── Cache entries ───────────────────────────────────────────────────────────

/**
 * A cached hook function plus the mtime of its source file. When the on-disk
 * mtime changes, the hook is re-imported and the entry is replaced.
 */
interface CachedHook {
  readonly hook: PluginHookFn;
  /** mtimeMs of the source file this hook was imported from. */
  readonly sourceMtime: number;
}

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
 * Cached hooks keyed by `${pluginName}/${hookName}`. The key includes the
 * plugin name so hooks from different plugins don't collide.
 */
const hookCache = new Map<string, CachedHook>();

/**
 * Cached tools keyed by `${pluginName}/${toolName}`. The key includes the
 * plugin name so tools from different plugins don't collide.
 */
const toolCache = new Map<string, CachedTool>();

/**
 * In-flight import promises, keyed by file path. Prevents duplicate
 * `import()` calls when multiple readers request the same surface
 * concurrently.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Plugin directories discovered at boot, in discovery order. Maps directory
 * path to the plugin's scope-stripped manifest name so eviction can find
 * the right cache key prefix without reading the (now-deleted) manifest.
 */
const discoveredPluginDirs = new Map<string, string>();

// ─── Mtime helpers ───────────────────────────────────────────────────────────

/**
 * Get the mtimeMs of a file, or 0 if the file doesn't exist or can't be
 * stat'd.
 */
function getMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// ─── Hook cache ──────────────────────────────────────────────────────────────

/**
 * Cache key for a hook: `${pluginName}/${hookName}`.
 */
function hookKey(pluginName: string, hookName: string): string {
  return `${pluginName}/${hookName}`;
}

/**
 * Get all hooks for a given event name from user plugins, re-importing
 * any whose source files have changed since the cache was populated.
 *
 * Also scans for newly added plugins and hooks (via directory listing).
 * Deleted plugins/hooks are skipped naturally (their directories/files
 * no longer appear in the listing).
 */
export async function getUserHooksFor<TCtx = unknown>(
  hookName: string,
): Promise<PluginHookFn<TCtx>[]> {
  await scanPlugins();

  const out: PluginHookFn<TCtx>[] = [];

  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    const hooksDir = join(pluginDir, "hooks");
    const surfaceFiles = listSurfaceDir(hooksDir);
    const hookFile = surfaceFiles.find((f) => f.name === hookName);
    if (hookFile === undefined) continue;

    const key = hookKey(pluginName, hookName);
    const currentMtime = getMtime(hookFile.path);

    // Cache hit — same mtime.
    const cached = hookCache.get(key);
    if (
      cached !== undefined &&
      cached.sourceMtime === currentMtime &&
      currentMtime > 0
    ) {
      out.push(cached.hook as PluginHookFn<TCtx>);
      continue;
    }

    // Cache miss — re-import.
    if (currentMtime === 0) {
      // File was deleted — evict cache entry.
      hookCache.delete(key);
      continue;
    }

    try {
      const hook = await importWithTimeout<PluginHookFn>(
        hookFile.path,
        importTimeoutMs,
      );
      if (hook === undefined || typeof hook !== "function") {
        log.error(
          { plugin: pluginName, hook: hookName, path: hookFile.path },
          `hook ${hookName} default export must be a function (got ${typeof hook}) — skipping`,
        );
        continue;
      }
      hookCache.set(key, { hook, sourceMtime: currentMtime });
      out.push(hook as PluginHookFn<TCtx>);
    } catch (err) {
      log.error(
        { err, plugin: pluginName, hook: hookName, path: hookFile.path },
        `Failed to import hook ${hookName} from ${hookFile.path}`,
      );
    }
  }

  return out;
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
      const toolSpec = await importWithTimeout<ToolDefinition>(
        file.path,
        importTimeoutMs,
      );
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

    const manifest = await parsePluginManifest(pluginDir);
    if (manifest === undefined) continue;
    const { name: pluginName } = manifest;

    currentDirs.set(pluginDir, pluginName);

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

  // Update the discovered set.
  discoveredPluginDirs.clear();
  for (const [dir, name] of currentDirs) {
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
  // Evict hooks.
  const hookPrefix = `${pluginName}/`;
  for (const key of hookCache.keys()) {
    if (key.startsWith(hookPrefix)) {
      hookCache.delete(key);
    }
  }

  // Evict tools.
  for (const key of toolCache.keys()) {
    if (key.startsWith(hookPrefix)) {
      toolCache.delete(key);
    }
  }

  log.info(
    { plugin: pluginName, pluginDir },
    "plugin evicted (directory removed)",
  );
  discoveredPluginDirs.delete(pluginDir);
}

/**
 * Evict all cache entries (when the plugins directory is gone entirely).
 */
async function evictAll(): Promise<void> {
  hookCache.clear();
  toolCache.clear();
  discoveredPluginDirs.clear();
}

// ─── Import dedup ────────────────────────────────────────────────────────────

/**
 * Import a module's default export with a timeout. If the import doesn't
 * resolve within `timeoutMs`, logs a warning and returns `undefined` so
 * a hanging plugin module doesn't block daemon startup indefinitely.
 */
async function importWithTimeout<T>(
  filePath: string,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSentinel = Symbol("import-timeout");
    const importPromise = importWithDedup<T>(filePath);
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
    });
    const result = await Promise.race([importPromise, timeoutPromise]);
    if (result === timeoutSentinel) {
      importPromise.catch(() => {
        /* swallow — late rejection from abandoned import */
      });
      log.warn(
        { filePath, timeoutMs },
        `Import timed out after ${timeoutMs}ms — skipping surface`,
      );
      return undefined;
    }
    return result as T;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Import a module's default export, deduplicating concurrent imports for
 * the same file path. This prevents two readers from triggering duplicate
 * `import()` calls when they request the same surface simultaneously.
 *
 * Note: Bun caches `import()` by URL within a process, so the dedup is
 * primarily about avoiding redundant async work, not about cache-busting.
 */
async function importWithDedup<T>(filePath: string): Promise<T> {
  let promise = inflight.get(filePath);
  if (promise === undefined) {
    promise = importDefault<T>(filePath);
    inflight.set(filePath, promise);
  }
  try {
    return (await promise) as T;
  } finally {
    inflight.delete(filePath);
  }
}

// ─── Boot population ─────────────────────────────────────────────────────────

/**
 * Plugins that were fully activated at boot (tools registered + init hook
 * run). Used by the shutdown hook to tear down only what was actually
 * brought up.
 */
const activatedPlugins: Array<{ name: string }> = [];

/**
 * Populate the cache at boot by scanning the plugins directory once,
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
    importTimeoutMs = opts.importTimeoutMs;
  }

  await scanPlugins();

  const shutdownContext: PluginShutdownContext = {
    assistantVersion: APP_VERSION,
  };

  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    // Pre-import all hooks so the first turn doesn't pay the import cost.
    const hooksDir = join(pluginDir, "hooks");
    const hookFiles = listSurfaceDir(hooksDir);
    for (const file of hookFiles) {
      const key = hookKey(pluginName, file.name);
      const currentMtime = getMtime(file.path);
      if (currentMtime === 0) continue;

      try {
        const hook = await importWithTimeout<PluginHookFn>(
          file.path,
          importTimeoutMs,
        );
        if (hook !== undefined && typeof hook === "function") {
          hookCache.set(key, { hook, sourceMtime: currentMtime });
        }
      } catch (err) {
        log.error(
          { err, plugin: pluginName, hook: file.name, path: file.path },
          `Failed to pre-import hook ${file.name}`,
        );
      }
    }

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
    const initHookEntry = hookCache.get(hookKey(pluginName, HOOKS.INIT));
    if (initHookEntry !== undefined) {
      try {
        const initContext: PluginInitContext = {
          config: getConfig().plugins?.[pluginName],
          credentials: {},
          logger: log.child({ plugin: pluginName }),
          pluginStorageDir: ensurePluginStorageDir(pluginName),
          assistantVersion: APP_VERSION,
        };
        await initHookEntry.hook(initContext);
        log.info({ plugin: pluginName }, "user plugin initialized");
      } catch (err) {
        log.error(
          { err, plugin: pluginName },
          `User plugin ${pluginName} init() failed — continuing`,
        );
      }
    }

    activatedPlugins.push({ name: pluginName });
  }

  // Register a single shutdown hook that walks all activated user plugins
  // in reverse order, unregistering tools and running shutdown hooks.
  const shutdownSnapshot = [...activatedPlugins];
  registerShutdownHook("user-plugins", async (reason) => {
    for (let i = shutdownSnapshot.length - 1; i >= 0; i--) {
      const { name } = shutdownSnapshot[i]!;

      // Unregister tools before running shutdown so onShutdown sees a
      // clean model-visible surface.
      try {
        unregisterPluginTools(name);
      } catch (err) {
        log.warn(
          { err, plugin: name, reason },
          "user plugin tool unregister failed (continuing)",
        );
      }

      // Run the `shutdown` hook if present.
      const shutdownHookEntry = hookCache.get(hookKey(name, HOOKS.SHUTDOWN));
      if (shutdownHookEntry !== undefined) {
        try {
          await shutdownHookEntry.hook(shutdownContext);
        } catch (err) {
          log.warn(
            { err, plugin: name, reason },
            "user plugin shutdown hook failed (continuing)",
          );
        }
      }
    }
  });
}

/**
 * Ensure `<workspaceDir>/plugins-data/<name>/` exists and return its path.
 */
function ensurePluginStorageDir(pluginName: string): string {
  const dir = join(getWorkspaceDir(), "plugins-data", pluginName);
  mkdirSync(dir, { recursive: true });
  return dir;
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
  hookCache.clear();
  toolCache.clear();
  inflight.clear();
  discoveredPluginDirs.clear();
  activatedPlugins.length = 0;
}

/**
 * Test-only: inspect the hook cache.
 */
export function _inspectHookCacheForTests(): Array<{
  key: string;
  sourceMtime: number;
}> {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "_inspectHookCacheForTests may only be called in test environments",
    );
  }
  return Array.from(hookCache.entries()).map(([key, c]) => ({
    key,
    sourceMtime: c.sourceMtime,
  }));
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
