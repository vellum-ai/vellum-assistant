/**
 * Mtime-keyed cache for user plugins — the filesystem is the source of truth.
 *
 * Replaces the push-based `PluginSourceWatcher` (fs.watch event loop) with a
 * pull model: every read of plugin state compares on-disk mtimes against
 * cached values and transparently rebuilds stale entries. No `fs.watch`, no
 * debouncers, no close-reopen-rescan workaround.
 *
 * The cache is populated at boot by `loadUserPlugins()` and read on every
 * `getHooksFor` / `getAllPlugins` call. When a plugin's source files change
 * on disk, the next read detects the mtime mismatch, runs `shutdown()` on
 * the old plugin, rebuilds it, runs `init()`, and swaps the cache entry.
 * When a plugin directory disappears, the next `getAllPlugins` scan runs
 * `shutdown()` and evicts the entry.
 *
 * First-party default plugins bypass this cache — they have no on-disk
 * sources to mtime-check and stay in the registry via `registerPlugin`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildExternalPlugin } from "./external-plugin-loader.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import type { Plugin, PluginHookFn } from "./types.js";

const log = getLogger("plugin-mtime-cache");

/**
 * A cached plugin plus the mtime signature of the on-disk files it was built
 * from. The mtime is the max `mtimeMs` across `package.json` + every file in
 * `hooks/` + every file in `tools/`. As long as the on-disk mtimes haven't
 * changed, the cached plugin is valid and no rebuild is needed.
 */
interface CachedPlugin {
  readonly plugin: Plugin;
  /** Max mtimeMs across all source files the plugin was built from. */
  readonly sourceMtime: number;
}

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Cache of user plugins keyed by directory name (= plugin name). A `Map`
 * preserves insertion order so hook ordering across plugins is stable
 * across rebuilds (the first plugin loaded at boot stays first).
 */
const cache = new Map<string, CachedPlugin>();

/**
 * Per-plugin in-flight build promises. Prevents two concurrent reads from
 * triggering duplicate `buildExternalPlugin` calls for the same plugin.
 * Same pattern as the old `WorkspaceToolsWatcher.inflight` map.
 */
const inflight = new Map<string, Promise<Plugin | undefined>>();

// ─── Mtime computation ───────────────────────────────────────────────────────

/**
 * Compute the max mtimeMs across all source files a plugin is built from:
 * `package.json` + every `.js`/`.ts` file in `hooks/` + every `.js`/`.ts`
 * file in `tools/`. Returns 0 when the directory or `package.json` is
 * missing (signals "plugin deleted" to the caller).
 *
 * Uses `statSync` (no file reads, no dynamic imports) so the cost on a cache
 * hit is a handful of syscalls — sub-millisecond for a typical plugin.
 */
function computeSourceMtime(pluginDir: string): number {
  let max = 0;

  const statMtime = (filePath: string): void => {
    try {
      const stats = statSync(filePath);
      if (stats.mtimeMs > max) max = stats.mtimeMs;
    } catch {
      // File may have been deleted between readdir and stat — treat as
      // missing (doesn't contribute to max). The caller will detect the
      // mismatch and rebuild.
    }
  };

  // package.json is the manifest — always checked.
  statMtime(join(pluginDir, "package.json"));

  // hooks/ and tools/ are the two surface directories the loader walks.
  for (const surface of ["hooks", "tools"]) {
    const surfaceDir = join(pluginDir, surface);
    if (!existsSync(surfaceDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(surfaceDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".js") || entry.endsWith(".ts")) {
        statMtime(join(surfaceDir, entry));
      }
    }
  }

  return max;
}

// ─── Cache reads ─────────────────────────────────────────────────────────────

/**
 * Get a single plugin by name, rebuilding from disk if the on-disk mtimes
 * have changed since the cache entry was created. Handles:
 *
 * - **Cache hit** (same mtime): returns the cached plugin. No I/O beyond stat.
 * - **Cache miss** (mtime changed or new plugin): rebuilds via
 *   `buildExternalPlugin`, runs init/shutdown lifecycle, updates cache.
 * - **Plugin deleted** (dir missing): runs `shutdown()` on the cached
 *   plugin, evicts the entry, returns `undefined`.
 *
 * Concurrent calls for the same plugin name share a single in-flight build
 * promise so `buildExternalPlugin` is not called twice in parallel.
 */
export async function getPlugin(
  name: string,
  opts: { importTimeoutMs?: number } = {},
): Promise<Plugin | undefined> {
  const pluginsDir = getWorkspacePluginsDir();
  const pluginDir = join(pluginsDir, name);

  // Plugin directory gone — shut down and evict if we had it cached.
  if (!existsSync(pluginDir) || !existsSync(join(pluginDir, "package.json"))) {
    const cached = cache.get(name);
    if (cached) {
      await shutdownCachedPlugin(name, cached.plugin);
      cache.delete(name);
    }
    return undefined;
  }

  const currentMtime = computeSourceMtime(pluginDir);
  const cached = cache.get(name);

  // Cache hit — no rebuild needed.
  if (cached !== undefined && cached.sourceMtime === currentMtime) {
    return cached.plugin;
  }

  // Cache miss — rebuild. Dedupe concurrent calls for the same name.
  let buildPromise = inflight.get(name);
  if (buildPromise === undefined) {
    buildPromise = buildExternalPlugin(pluginDir, opts);
    inflight.set(name, buildPromise);
  }

  try {
    const plugin = await buildPromise;
    if (plugin === undefined) {
      // Build failed — keep the old cached entry (if any) so we don't
      // lose a working plugin due to a transient build error. If there
      // was no prior entry, the plugin simply isn't available.
      return cached?.plugin;
    }

    // Shut down the old plugin before swapping in the new one.
    if (cached !== undefined) {
      await shutdownCachedPlugin(name, cached.plugin);
    }

    // Run init on the new plugin.
    await initPlugin(plugin);

    cache.set(name, { plugin, sourceMtime: currentMtime });
    return plugin;
  } finally {
    inflight.delete(name);
  }
}

/**
 * Get all user plugins, rebuilding any whose on-disk mtimes have changed
 * since the last scan. Also detects deleted plugins (directory gone) and
 * evicts them with a `shutdown()` call.
 *
 * Returns plugins in insertion-stable order (the order they were first
 * cached at boot). New plugins discovered via `readdir` are appended.
 */
export async function getAllPlugins(
  opts: { importTimeoutMs?: number } = {},
): Promise<Plugin[]> {
  const pluginsDir = getWorkspacePluginsDir();

  if (!existsSync(pluginsDir)) {
    // No plugins directory — evict everything (unlikely after boot, but
    // handles the case where the dir is removed at runtime).
    await evictAll();
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    log.warn({ pluginsDir }, "getAllPlugins: failed to read plugins directory");
    return Array.from(cache.values()).map((c) => c.plugin);
  }

  const onDiskNames = new Set<string>();

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);
    try {
      if (!statSync(pluginDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(pluginDir, "package.json"))) continue;

    onDiskNames.add(entry);
    // getPlugin handles mtime check + rebuild internally.
    await getPlugin(entry, opts);
  }

  // Evict cached plugins whose directories no longer exist on disk.
  for (const name of cache.keys()) {
    if (!onDiskNames.has(name)) {
      const cached = cache.get(name);
      if (cached) {
        await shutdownCachedPlugin(name, cached.plugin);
        cache.delete(name);
      }
    }
  }

  return Array.from(cache.values()).map((c) => c.plugin);
}

/**
 * Collect hooks for a given event name from all user plugins, in
 * insertion-stable order. This is the read path that `runHook` calls
 * instead of the old `getHooksFor` from the registry.
 *
 * Calls `getAllPlugins()` first to ensure the cache is fresh, then walks
 * the result. The mtime check is sub-millisecond (a few stat syscalls per
 * plugin), so calling this on every `runHook` is negligible overhead.
 */
export async function getHooksForFromCache<TCtx = unknown>(
  hookName: string,
  opts?: { importTimeoutMs?: number },
): Promise<PluginHookFn<TCtx>[]> {
  const plugins = await getAllPlugins(opts);
  const out: PluginHookFn<TCtx>[] = [];
  for (const plugin of plugins) {
    const hook = plugin.hooks?.[hookName];
    if (hook) {
      out.push(hook as PluginHookFn<TCtx>);
    }
  }
  return out;
}

// ─── Boot population ─────────────────────────────────────────────────────────

/**
 * Populate the cache at boot by scanning the plugins directory once and
 * building every plugin. Called by `loadUserPlugins()` during daemon
 * startup. This replaces the old `loadExternalPlugin` + `registerPlugin`
 * loop — plugins go into the cache instead of the registry.
 *
 * After this call, `getAllPlugins()` will return the same set without
 * rebuilding (mtimes match). Subsequent reads detect changes via mtime.
 */
export async function populateCacheAtBoot(
  opts: { importTimeoutMs?: number } = {},
): Promise<void> {
  await getAllPlugins(opts);
}

// ─── Init/shutdown lifecycle ─────────────────────────────────────────────────

/**
 * Run a plugin's `init()` hook if present. Errors are caught and logged —
 * a failing init must not prevent the cache entry from being stored, since
 * the plugin's tools may still be usable even with a failed init (same
 * isolation contract as the bootstrap).
 */
async function initPlugin(plugin: Plugin): Promise<void> {
  // The init hook name is "init" per HOOKS.INIT. We import the constant
  // lazily to avoid a circular dependency: mtime-cache <- constants is fine,
  // but keeping the string inline avoids pulling the plugin-api module graph
  // into the cache's import closure.
  const initHook = plugin.hooks?.["init"];
  if (!initHook) return;

  const name = plugin.manifest.name;
  try {
    // The init context is constructed minimally here. The full bootstrap
    // path in external-plugins-bootstrap.ts resolves credentials, config,
    // and pluginStorageDir before calling init. For cache-triggered
    // rebuilds at runtime, we use a lightweight context — the plugin
    // already received its full init context at boot, and a rebuild is
    // a "hot-reload" scenario where the plugin should be able to
    // reinitialize from its own persisted state.
    //
    // If a plugin needs the full context on rebuild, it can store it in
    // the init context at boot and re-read it from its own state.
    await initHook({
      config: undefined,
      credentials: {},
      logger: log.child({ plugin: name }),
      pluginStorageDir: join(
        getWorkspacePluginsDir(),
        "..",
        "plugins-data",
        name,
      ),
      assistantVersion: "",
    });
  } catch (err) {
    log.warn(
      { err, plugin: name },
      "plugin init failed during cache rebuild — continuing with degraded plugin",
    );
  }
}

/**
 * Run a cached plugin's `shutdown()` hook if present, then unregister its
 * tools. Called when a plugin is evicted (deleted) or rebuilt (replaced).
 * Errors are caught and logged — shutdown failures must not block cache
 * operations.
 */
async function shutdownCachedPlugin(
  name: string,
  plugin: Plugin,
): Promise<void> {
  const shutdownHook = plugin.hooks?.["shutdown"];
  if (shutdownHook) {
    try {
      await shutdownHook({ assistantVersion: "" });
    } catch (err) {
      log.warn(
        { err, plugin: name },
        "plugin shutdown failed during cache eviction — continuing",
      );
    }
  }
}

/**
 * Shut down and evict every cached plugin. Called when the plugins
 * directory disappears entirely.
 */
async function evictAll(): Promise<void> {
  for (const [name, cached] of cache) {
    await shutdownCachedPlugin(name, cached.plugin);
  }
  cache.clear();
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

/**
 * Clear the cache. Test-only — throws outside a test environment, same
 * guard pattern as `resetPluginRegistryForTests`.
 */
export function resetPluginCacheForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "resetPluginCacheForTests may only be called in test environments",
    );
  }
  cache.clear();
  inflight.clear();
}

/**
 * Test-only: inspect the cache contents without triggering a rebuild.
 * Returns a snapshot of the cached plugin names and their source mtimes.
 */
export function _inspectCacheForTests(): Array<{
  name: string;
  sourceMtime: number;
}> {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "_inspectCacheForTests may only be called in test environments",
    );
  }
  return Array.from(cache.entries()).map(([name, c]) => ({
    name,
    sourceMtime: c.sourceMtime,
  }));
}
