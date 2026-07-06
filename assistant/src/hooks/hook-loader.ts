/**
 * Hook surface loader — the first-class home for user-land lifecycle/event
 * hooks.
 *
 * A "hook" is a named lifecycle event (`init`, `shutdown`, `user-prompt-submit`,
 * `post-tool-use`, `stop`, ...) handled by a default export. Hooks come from
 * two surfaces, both cached here keyed by their source file's mtime:
 *
 * - **Plugin hooks** — `<workspace>/plugins/<name>/hooks/<event>.{ts,js}`,
 *   discovered alongside the owning plugin's tools.
 * - **Workspace hooks** — `<workspace>/hooks/<event>.{ts,js}`, standalone
 *   files not tied to any plugin (no `package.json`, no tools — just hooks).
 *
 * This module owns the hook cache and every hook operation (collect, init,
 * shutdown, eviction). Plugin *discovery* (which plugin directories exist, in
 * what order) lives in `../plugins/mtime-cache.ts`; the orchestrator there
 * passes the discovered directories into {@link collectUserHooks} and drives
 * pre-import / init / shutdown at boot. Keeping discovery out of this module
 * lets it sit below the plugin cache with no import cycle.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { HOOKS } from "../plugin-api/constants.js";
import type {
  HookFunction,
  InitContext,
  ShutdownContext,
} from "../plugin-api/types.js";
import { listSurfaceDir } from "../plugins/external-plugin-loader.js";
import {
  evictModule,
  getMtime,
  importWithTimeout,
} from "../plugins/surface-import.js";
import type { HookEntry } from "../plugins/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspaceHooksDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";

const log = getLogger("hook-loader");

/**
 * Synthetic owner name for standalone hooks that live directly under
 * `<workspace>/hooks/` rather than inside a plugin's `hooks/` directory.
 *
 * Used as the cache-key prefix (`__workspace__/<hookName>`) so workspace
 * hooks never collide with a plugin's hooks. The leading/trailing double
 * underscores keep it disjoint from any scope-stripped npm package name a
 * real plugin could carry.
 */
export const WORKSPACE_HOOKS_OWNER = "__workspace__";

/**
 * A cached hook function plus the mtime of its source file. When the on-disk
 * mtime changes, the hook is re-imported and the entry is replaced.
 */
interface CachedHook {
  readonly hook: HookFunction;
  /** mtimeMs of the source file this hook was imported from. */
  readonly sourceMtime: number;
}

/**
 * Cached hooks keyed by `${ownerName}/${hookName}`. The key includes the
 * owner (plugin name, or {@link WORKSPACE_HOOKS_OWNER}) so hooks from
 * different owners don't collide.
 */
const hookCache = new Map<string, CachedHook>();

/** Cache key for a hook: `${ownerName}/${hookName}`. */
function hookKey(ownerName: string, hookName: string): string {
  return `${ownerName}/${hookName}`;
}

/**
 * Resolve a single hook file through the mtime cache: return the cached hook
 * when its source mtime is unchanged, otherwise re-import and refresh the
 * entry. Returns `undefined` when the file was deleted (evicting any stale
 * entry) or the import failed / produced a non-function default export.
 *
 * `ownerName` is the cache-key prefix and the attribution label in logs (a
 * plugin name, or {@link WORKSPACE_HOOKS_OWNER}).
 */
async function resolveCachedHook<TCtx>(
  ownerName: string,
  hookName: string,
  filePath: string,
): Promise<HookFunction<TCtx> | undefined> {
  const key = hookKey(ownerName, hookName);
  const currentMtime = getMtime(filePath);

  // Cache hit — same mtime.
  const cached = hookCache.get(key);
  if (
    cached !== undefined &&
    cached.sourceMtime === currentMtime &&
    currentMtime > 0
  ) {
    return cached.hook as HookFunction<TCtx>;
  }

  // Cache miss — re-import.
  if (currentMtime === 0) {
    // File was deleted between listing and stat — evict the cache entry.
    hookCache.delete(key);
    return undefined;
  }

  // The file is new, recreated, or edited since it was last imported. Evict
  // it from the runtime module registry first: without this, the import
  // below would return the module Bun cached at the old content and the
  // edit would never take effect. No-op for a first-ever load.
  //
  // Note the reload swaps only the exported function for future dispatches.
  // The hook file's top-level code runs again on re-import, and nothing
  // tears down the previous instance — so hook files must keep long-lived
  // side effects (timers, listeners) in the owner's `init`/`shutdown`
  // lifecycle, not at module top level.
  evictModule(filePath);

  try {
    const hook = await importWithTimeout<HookFunction>(filePath);
    if (hook === undefined || typeof hook !== "function") {
      log.error(
        { plugin: ownerName, hook: hookName, path: filePath },
        `hook ${hookName} default export must be a function (got ${typeof hook}) — skipping`,
      );
      return undefined;
    }
    hookCache.set(key, { hook, sourceMtime: currentMtime });
    return hook as HookFunction<TCtx>;
  } catch (err) {
    log.error(
      { err, plugin: ownerName, hook: hookName, path: filePath },
      `Failed to import hook ${hookName} from ${filePath}`,
    );
    return undefined;
  }
}

/**
 * Collect every hook for a given event name across all surfaces, re-importing
 * any whose source file's mtime changed since the cache was populated.
 *
 * `pluginDirs` is the orchestrator's discovered `[dir, ownerName]` set (in
 * install-date order). Each plugin's hook runs first, then the standalone
 * workspace hook under `<workspace>/hooks/<hookName>.{ts,js}` runs last — so
 * a plugin can shape the threaded context before a workspace-wide hook
 * observes or finalizes it.
 *
 * Added, removed, and edited hook files are all picked up live: discovery is
 * by directory listing, and a changed source mtime evicts the module from
 * the runtime registry before re-import, so the edited hook takes effect on
 * the next dispatch without a daemon restart. For plugin hooks, helper
 * modules are covered too: the plugin scan in `../plugins/mtime-cache.ts`
 * fingerprints every source file under the plugin directory and redeploys
 * the plugin when any of them change. Standalone workspace hooks are single
 * files by design (every file in the directory is treated as a hook), so
 * only the hook file itself is watched there.
 *
 * `effectiveEnabledPlugins` carries the per-chat plugin scope: when non-null, a
 * plugin whose name is not in the set is skipped (its hooks do not run for this
 * conversation). The standalone workspace hook is not owned by a plugin, so it
 * always runs. `null`/omitted means no per-chat restriction.
 */
export async function collectUserHookEntries<TCtx = unknown>(
  hookName: string,
  pluginDirs: Iterable<readonly [string, string]>,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookEntry<TCtx>[]> {
  const out: HookEntry<TCtx>[] = [];

  for (const [pluginDir, pluginName] of pluginDirs) {
    if (
      effectiveEnabledPlugins != null &&
      !effectiveEnabledPlugins.has(pluginName)
    ) {
      continue;
    }
    const hookFile = listSurfaceDir(join(pluginDir, "hooks")).find(
      (f) => f.name === hookName,
    );
    if (hookFile === undefined) {
      continue;
    }

    const hook = await resolveCachedHook<TCtx>(
      pluginName,
      hookName,
      hookFile.path,
    );
    if (hook !== undefined) {
      out.push({ fn: hook, owner: { kind: "plugin", id: pluginName } });
    }
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
    if (hook !== undefined) {
      out.push({
        fn: hook,
        owner: { kind: "workspace", id: WORKSPACE_HOOKS_OWNER },
      });
    }
  }

  return out;
}

/**
 * {@link collectUserHookEntries} without owner attribution — returns just the
 * hook functions in the same order. For callers that only dispatch the chain
 * and don't attribute per-hook side effects.
 */
export async function collectUserHooks<TCtx = unknown>(
  hookName: string,
  pluginDirs: Iterable<readonly [string, string]>,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookFunction<TCtx>[]> {
  const entries = await collectUserHookEntries<TCtx>(
    hookName,
    pluginDirs,
    effectiveEnabledPlugins,
  );
  return entries.map((e) => e.fn);
}

/**
 * Pre-import every hook file under `hooksDir` and cache it keyed by
 * `${ownerName}/${hookName}`, so the first turn doesn't pay the import cost.
 * Best-effort per file: a failing import is logged and skipped. A missing
 * directory yields no files (handled by {@link listSurfaceDir}).
 */
export async function preImportHooksDir(
  hooksDir: string,
  ownerName: string,
): Promise<void> {
  for (const file of listSurfaceDir(hooksDir)) {
    const key = hookKey(ownerName, file.name);
    const currentMtime = getMtime(file.path);
    if (currentMtime === 0) {
      continue;
    }

    // A plugin directory can be removed and reinstalled while the daemon
    // runs; evict any module cached from the prior install so the
    // pre-import reflects what's on disk now. No-op at boot.
    evictModule(file.path);

    try {
      const hook = await importWithTimeout<HookFunction>(file.path);
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
 * Whether the standalone workspace hooks directory currently holds any hook
 * files. Used by the boot orchestrator to skip activating (and registering
 * teardown for) an empty/absent directory.
 */
export function hasWorkspaceHooks(): boolean {
  return listSurfaceDir(getWorkspaceHooksDir()).length > 0;
}

/**
 * Pre-import the standalone workspace hooks under {@link WORKSPACE_HOOKS_OWNER}.
 * Convenience wrapper over {@link preImportHooksDir} that keeps the workspace
 * hooks directory path inside this module.
 */
export async function preImportWorkspaceHooks(): Promise<void> {
  await preImportHooksDir(getWorkspaceHooksDir(), WORKSPACE_HOOKS_OWNER);
}

/**
 * Run the `init` hook for `ownerName` if one was pre-imported into the cache.
 * Shared by user plugins and standalone workspace hooks so both get the same
 * init-context shape and per-owner isolation (a thrown `init` is logged and
 * swallowed, never blocking boot).
 *
 * For user plugins, `pluginDir` is the absolute path to the installed plugin
 * directory (`<workspace>/plugins/<name>/`). Config and data now live inside
 * the plugin directory as preserved entries:
 *
 * - `<pluginDir>/config.json` — user-editable config (replaces the global
 *   `config.plugins.<name>` block).
 * - `<pluginDir>/data/` — runtime data directory (replaces
 *   `<workspace>/plugins-data/<name>/`).
 *
 * On first encounter after upgrade, any config or data still at the old
 * locations is migrated into the plugin directory so existing setups keep
 * working without manual intervention. For standalone workspace hooks
 * (`WORKSPACE_HOOKS_OWNER`), `pluginDir` is `null` and the old paths are used
 * as-is since workspace hooks have no plugin directory.
 */
export async function runInitHook(
  ownerName: string,
  pluginDir: string | null = null,
): Promise<void> {
  const initHookEntry = hookCache.get(hookKey(ownerName, HOOKS.INIT));
  if (initHookEntry === undefined) {
    return;
  }

  try {
    const initContext: InitContext = {
      config: resolvePluginConfig(ownerName, pluginDir),
      logger: log.child({ plugin: ownerName }),
      pluginStorageDir: resolvePluginStorageDir(ownerName, pluginDir),
      assistantVersion: APP_VERSION,
    };
    await initHookEntry.hook(initContext);
    log.info({ plugin: ownerName }, "user hooks initialized");
  } catch (err) {
    log.error(
      { err, plugin: ownerName },
      `User hooks for ${ownerName} init() failed — continuing`,
    );
  }
}

/**
 * Run the `shutdown` hook for `ownerName` if one is cached. Best-effort: a
 * thrown shutdown is logged and swallowed. `reason` is threaded into the log
 * for attribution only.
 */
export async function runShutdownHook(
  ownerName: string,
  context: ShutdownContext,
  reason: string,
): Promise<void> {
  const shutdownHookEntry = hookCache.get(hookKey(ownerName, HOOKS.SHUTDOWN));
  if (shutdownHookEntry === undefined) {
    return;
  }

  try {
    await shutdownHookEntry.hook(context);
  } catch (err) {
    log.warn(
      { err, plugin: ownerName, reason },
      "user hooks shutdown failed (continuing)",
    );
  }
}

/**
 * Evict every cached hook owned by `ownerName` (e.g. when a plugin directory
 * is removed). No-op when the owner has no cached hooks.
 */
export function evictHooksForOwner(ownerName: string): void {
  const prefix = `${ownerName}/`;
  for (const key of hookCache.keys()) {
    if (key.startsWith(prefix)) {
      hookCache.delete(key);
    }
  }
}

/**
 * Evict all plugin-owned hooks while preserving standalone workspace hooks.
 * Called when the plugins directory is gone entirely: workspace hooks live
 * outside it, so the absence of any plugin must not evict them.
 */
export function clearPluginHooks(): void {
  for (const key of hookCache.keys()) {
    if (!key.startsWith(`${WORKSPACE_HOOKS_OWNER}/`)) {
      hookCache.delete(key);
    }
  }
}

/**
 * Filename for user-editable plugin config inside the plugin directory.
 */
const PLUGIN_CONFIG_FILENAME = "config.json";

/**
 * Directory name for per-plugin runtime data inside the plugin directory.
 */
const PLUGIN_DATA_DIRNAME = "data";

/**
 * Resolve a plugin's config for the init context. For user plugins with a
 * `pluginDir`, config lives at `<pluginDir>/config.json`. If that file
 * doesn't exist yet but the old global config block (`config.plugins.<name>`)
 * has a value, the value is written to `config.json` as a one-time migration.
 *
 * For standalone workspace hooks (no `pluginDir`), the old global config block
 * is returned as-is since there's no plugin directory to migrate into.
 */
function resolvePluginConfig(
  ownerName: string,
  pluginDir: string | null,
): unknown {
  if (pluginDir === null) {
    return getConfig().plugins?.[ownerName];
  }

  const configPath = join(pluginDir, PLUGIN_CONFIG_FILENAME);

  // Migrate: if config.json doesn't exist but the old global config has a
  // value, write it to the new location so the user's config is preserved.
  if (!existsSync(configPath)) {
    const oldConfig = getConfig().plugins?.[ownerName];
    if (oldConfig !== undefined) {
      try {
        writeFileSync(configPath, JSON.stringify(oldConfig, null, 2));
        log.info(
          { plugin: ownerName, configPath },
          "migrated plugin config from global config to plugin directory",
        );
      } catch (err) {
        log.warn(
          { err, plugin: ownerName, configPath },
          "failed to migrate plugin config to plugin directory — using old value",
        );
        return oldConfig;
      }
    }
    return oldConfig;
  }

  // Config.json exists — read and parse it.
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err, plugin: ownerName, configPath },
      "failed to read plugin config.json — returning undefined",
    );
    return undefined;
  }
}

/**
 * Resolve a plugin's runtime data directory for the init context. For user
 * plugins with a `pluginDir`, data lives at `<pluginDir>/data/`. If that
 * directory doesn't exist but the old `<workspace>/plugins-data/<name>/` does,
 * its contents are moved into the new location as a one-time migration.
 *
 * For standalone workspace hooks (no `pluginDir`), the old
 * `<workspace>/plugins-data/<name>/` path is used and created as-is.
 */
function resolvePluginStorageDir(
  ownerName: string,
  pluginDir: string | null,
): string {
  if (pluginDir === null) {
    return ensureLegacyStorageDir(ownerName);
  }

  const dataDir = join(pluginDir, PLUGIN_DATA_DIRNAME);

  // Migrate: if data/ doesn't exist but the old plugins-data/<name>/ does,
  // move its contents into the new location.
  if (!existsSync(dataDir)) {
    const oldDir = join(getWorkspaceDir(), "plugins-data", ownerName);
    if (existsSync(oldDir)) {
      try {
        mkdirSync(dataDir, { recursive: true });
        cpSync(oldDir, dataDir, { recursive: true });
        rmSync(oldDir, { recursive: true, force: true });
        log.info(
          { plugin: ownerName, oldDir, dataDir },
          "migrated plugin data from plugins-data to plugin directory",
        );
      } catch (err) {
        log.warn(
          { err, plugin: ownerName, oldDir, dataDir },
          "failed to migrate plugin data to plugin directory — using old location",
        );
        return ensureLegacyStorageDir(ownerName);
      }
    }
  }

  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Ensure `<workspaceDir>/plugins-data/<name>/` exists and return its path.
 * Used only for standalone workspace hooks and as a fallback during migration.
 */
function ensureLegacyStorageDir(ownerName: string): string {
  const dir = join(getWorkspaceDir(), "plugins-data", ownerName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

/** Clear the hook cache. Test-only. */
export function resetHookCacheForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "resetHookCacheForTests may only be called in test environments",
    );
  }
  hookCache.clear();
}

/** Test-only: inspect the hook cache. */
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
