/**
 * Per-surface mtime cache for user plugins.
 *
 * Instead of caching whole `Plugin` objects, this module caches individual
 * hooks and tools keyed by their source file's mtime. This means:
 *
 * - A changed hook file triggers a re-import of just that hook, not a full
 *   plugin rebuild.
 * - The same machinery serves both per-plugin hooks (under
 *   `<workspace>/plugins/<name>/hooks/`) and standalone workspace hooks
 *   (under `<workspace>/hooks/`), since each surface is cached independently.
 * - Plugins are never "registered" as a unit — we just register their tools
 *   and hooks into the global registries, then cache-bust them using mtime
 *   on reads.
 *
 * The cache is populated at boot by `loadUserPlugins()` and read on every
 * `getHooksFor` / `getAllTools` call. When a surface file's mtime changes,
 * the next read detects the mismatch, re-imports the file, and swaps the
 * cached entry.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
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
import {
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";
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
 * Synthetic owner name for standalone hooks that live directly under
 * `<workspace>/hooks/` rather than inside a plugin's `hooks/` directory.
 *
 * Used as the cache-key prefix (`__workspace__/<hookName>`) so workspace
 * hooks never collide with a plugin's hooks. The leading/trailing double
 * underscores keep it disjoint from any scope-stripped npm package name a
 * real plugin could carry.
 */
const WORKSPACE_HOOKS_OWNER = "__workspace__";

/**
 * Import timeout for surface file imports. Set by `populateCacheAtBoot` from
 * the value passed by `loadUserPlugins`, and used by `getUserHooksFor` and
 * `reconcilePluginTools` for runtime re-imports. Defaults to 10s.
 */
let importTimeoutMs = 10_000;

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

/**
 * Plugin directories that have a `.disabled` sentinel and were logged as
 * disabled. Tracked so we only emit the "plugin disabled" log line once
 * per scan cycle (the scan runs on every hook read). Cleared when a plugin
 * transitions back to active or is evicted entirely.
 */
const disabledPluginDirs = new Set<string>();

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
 * Resolve a single hook file through the mtime cache: return the cached hook
 * when its source mtime is unchanged, otherwise re-import and refresh the
 * entry. Returns `undefined` when the file was deleted (evicting any stale
 * entry) or the import failed / produced a non-function default export.
 *
 * Shared by the plugin-hooks loop and the workspace-hooks scan in
 * {@link getUserHooksFor} so both surfaces get identical cache, timeout, and
 * attribution semantics. `ownerName` is the cache-key prefix and the
 * attribution label in logs (a plugin name, or {@link WORKSPACE_HOOKS_OWNER}).
 */
async function resolveCachedHook<TCtx>(
  ownerName: string,
  hookName: string,
  filePath: string,
): Promise<PluginHookFn<TCtx> | undefined> {
  const key = hookKey(ownerName, hookName);
  const currentMtime = getMtime(filePath);

  // Cache hit — same mtime.
  const cached = hookCache.get(key);
  if (
    cached !== undefined &&
    cached.sourceMtime === currentMtime &&
    currentMtime > 0
  ) {
    return cached.hook as PluginHookFn<TCtx>;
  }

  // Cache miss — re-import.
  if (currentMtime === 0) {
    // File was deleted between listing and stat — evict the cache entry.
    hookCache.delete(key);
    return undefined;
  }

  try {
    const hook = await importWithTimeout<PluginHookFn>(
      filePath,
      importTimeoutMs,
    );
    if (hook === undefined || typeof hook !== "function") {
      log.error(
        { plugin: ownerName, hook: hookName, path: filePath },
        `hook ${hookName} default export must be a function (got ${typeof hook}) — skipping`,
      );
      return undefined;
    }
    hookCache.set(key, { hook, sourceMtime: currentMtime });
    return hook as PluginHookFn<TCtx>;
  } catch (err) {
    log.error(
      { err, plugin: ownerName, hook: hookName, path: filePath },
      `Failed to import hook ${hookName} from ${filePath}`,
    );
    return undefined;
  }
}

/**
 * Get all hooks for a given event name from user plugins and from standalone
 * workspace hooks, re-importing any whose source files have changed since the
 * cache was populated.
 *
 * Also scans for newly added plugins and hooks (via directory listing).
 * Deleted plugins/hooks are skipped naturally (their directories/files
 * no longer appear in the listing).
 *
 * Ordering: each plugin's hook (in install-date order) runs first, then the
 * standalone workspace hook under `<workspace>/hooks/<hookName>.{ts,js}`, so a
 * plugin can shape the threaded context before a workspace-wide hook observes
 * or finalizes it.
 */
export async function getUserHooksFor<TCtx = unknown>(
  hookName: string,
): Promise<PluginHookFn<TCtx>[]> {
  await scanPlugins();

  const out: PluginHookFn<TCtx>[] = [];

  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    const hookFile = listSurfaceDir(join(pluginDir, "hooks")).find(
      (f) => f.name === hookName,
    );
    if (hookFile === undefined) continue;

    const hook = await resolveCachedHook<TCtx>(
      pluginName,
      hookName,
      hookFile.path,
    );
    if (hook !== undefined) out.push(hook);
  }

  // Standalone workspace hooks: files directly under `<workspace>/hooks/`
  // that are not part of any plugin (no package.json, no tools — just hooks).
  const wsHookFile = listSurfaceDir(getWorkspaceHooksDir()).find(
    (f) => f.name === hookName,
  );
  if (wsHookFile !== undefined) {
    const hook = await resolveCachedHook<TCtx>(
      WORKSPACE_HOOKS_OWNER,
      hookName,
      wsHookFile.path,
    );
    if (hook !== undefined) out.push(hook);
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
  installDateCache.delete(pluginDir);
}

/**
 * Evict all plugin-owned cache entries (when the plugins directory is gone
 * entirely). Workspace hooks under `<workspace>/hooks/` are preserved: they
 * live outside the plugins directory, so the absence of any plugin must not
 * evict them. Their own deletion is handled per-file in {@link resolveCachedHook}.
 */
async function evictAll(): Promise<void> {
  for (const key of hookCache.keys()) {
    if (!key.startsWith(`${WORKSPACE_HOOKS_OWNER}/`)) {
      hookCache.delete(key);
    }
  }
  toolCache.clear();
  discoveredPluginDirs.clear();
  installDateCache.clear();
  disabledPluginDirs.clear();
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
 * Pre-import every hook file under `hooksDir` and cache it keyed by
 * `${ownerName}/${hookName}`, so the first turn doesn't pay the import cost.
 * Best-effort per file: a failing import is logged and skipped. A missing
 * directory yields no files (handled by {@link listSurfaceDir}).
 */
async function preImportHooksDir(
  hooksDir: string,
  ownerName: string,
): Promise<void> {
  for (const file of listSurfaceDir(hooksDir)) {
    const key = hookKey(ownerName, file.name);
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
        { err, plugin: ownerName, hook: file.name, path: file.path },
        `Failed to pre-import hook ${file.name}`,
      );
    }
  }
}

/**
 * Run the `init` hook for `ownerName` if one was pre-imported into the cache.
 * Shared by user plugins and standalone workspace hooks so both get the same
 * init-context shape and per-owner isolation (a thrown `init` is logged and
 * swallowed, never blocking boot).
 */
async function runInitHook(ownerName: string): Promise<void> {
  const initHookEntry = hookCache.get(hookKey(ownerName, HOOKS.INIT));
  if (initHookEntry === undefined) return;

  try {
    const initContext: PluginInitContext = {
      config: getConfig().plugins?.[ownerName],
      credentials: {},
      logger: log.child({ plugin: ownerName }),
      pluginStorageDir: ensurePluginStorageDir(ownerName),
      assistantVersion: APP_VERSION,
    };
    await initHookEntry.hook(initContext);
    log.info({ plugin: ownerName }, "user plugin initialized");
  } catch (err) {
    log.error(
      { err, plugin: ownerName },
      `User plugin ${ownerName} init() failed — continuing`,
    );
  }
}

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
  if (listSurfaceDir(getWorkspaceHooksDir()).length > 0) {
    await preImportHooksDir(getWorkspaceHooksDir(), WORKSPACE_HOOKS_OWNER);
    await runInitHook(WORKSPACE_HOOKS_OWNER);
    activatedPlugins.push({ name: WORKSPACE_HOOKS_OWNER });
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
  installDateCache.clear();
  activatedPlugins.length = 0;
  disabledPluginDirs.clear();
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
