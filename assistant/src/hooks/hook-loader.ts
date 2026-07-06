/**
 * Hook surface loader — the first-class home for user-land lifecycle/event
 * hooks.
 *
 * A "hook" is a named lifecycle event (`init`, `shutdown`, `user-prompt-submit`,
 * `post-tool-use`, `stop`, ...) handled by a default export. Hooks come from
 * two surfaces:
 *
 * - **Plugin hooks** — `<workspace>/plugins/<name>/hooks/<event>.{ts,js}`,
 *   discovered alongside the owning plugin's tools.
 * - **Workspace hooks** — `<workspace>/hooks/<event>.{ts,js}`, standalone
 *   files not tied to any plugin (no `package.json`, no tools — just hooks).
 *
 * Hook dispatch is a hot path, so collecting hooks costs no filesystem
 * operations: every hook function enters the in-memory cache when its owner
 * is (re)activated ({@link preImportHooksDir}), and dispatch is pure map
 * lookups. Source changes reach the cache through the source-versions
 * reconcile in `../plugins/mtime-cache.ts`, which tears the owner down,
 * evicts its cache entries and modules, and reactivates it — dispatch never
 * stats, lists, or imports.
 *
 * This module owns the hook cache and every hook operation (collect, init,
 * shutdown, eviction). Plugin *discovery* (which plugin directories exist, in
 * what order) lives in `../plugins/mtime-cache.ts`; the orchestrator there
 * passes the discovered directories into {@link collectUserHooks} and drives
 * pre-import / init / shutdown. Keeping discovery out of this module lets it
 * sit below the plugin cache with no import cycle.
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
import { evictModule, importWithTimeout } from "../plugins/surface-import.js";
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

/** A cached, imported hook function. */
interface CachedHook {
  readonly hook: HookFunction;
}

/**
 * Cached hooks keyed by `${ownerName}/${hookName}`. The key includes the
 * owner (plugin name, or {@link WORKSPACE_HOOKS_OWNER}) so hooks from
 * different owners don't collide. Entries are created when an owner is
 * (re)activated and removed only by owner-level eviction — the cache is the
 * complete record of an owner's dispatchable hooks.
 */
const hookCache = new Map<string, CachedHook>();

/** Cache key for a hook: `${ownerName}/${hookName}`. */
function hookKey(ownerName: string, hookName: string): string {
  return `${ownerName}/${hookName}`;
}

/**
 * Collect every cached hook for a given event name across all surfaces.
 * Pure in-memory lookups — no filesystem operations on the dispatch path.
 *
 * `pluginDirs` is the orchestrator's discovered `[dir, ownerName]` set (in
 * install-date order). Each plugin's hook runs first, then the standalone
 * workspace hook runs last — so a plugin can shape the threaded context
 * before a workspace-wide hook observes or finalizes it.
 *
 * The cache holds exactly what each owner's last (re)activation imported;
 * added, removed, and edited hook files (including helper modules they
 * import) land when the source-versions reconcile redeploys the owner.
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

  for (const [, pluginName] of pluginDirs) {
    if (
      effectiveEnabledPlugins != null &&
      !effectiveEnabledPlugins.has(pluginName)
    ) {
      continue;
    }
    const cached = hookCache.get(hookKey(pluginName, hookName));
    if (cached !== undefined) {
      out.push({
        fn: cached.hook as HookFunction<TCtx>,
        owner: { kind: "plugin", id: pluginName },
      });
    }
  }

  // Standalone workspace hooks: files directly under `<workspace>/hooks/`
  // that are not part of any plugin (no package.json, no tools — just hooks).
  const wsCached = hookCache.get(hookKey(WORKSPACE_HOOKS_OWNER, hookName));
  if (wsCached !== undefined) {
    out.push({
      fn: wsCached.hook as HookFunction<TCtx>,
      owner: { kind: "workspace", id: WORKSPACE_HOOKS_OWNER },
    });
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
 * Import every hook file under `hooksDir` into the cache, keyed by
 * `${ownerName}/${hookName}`. This is the single point where hook code
 * enters the process: it runs at owner (re)activation, and what it caches
 * is exactly what dispatch serves until the owner is next redeployed.
 * Best-effort per file: a failing or non-function import is logged and
 * skipped (the owner's other hooks still load). A missing directory yields
 * no files (handled by {@link listSurfaceDir}).
 */
export async function preImportHooksDir(
  hooksDir: string,
  ownerName: string,
): Promise<void> {
  for (const file of listSurfaceDir(hooksDir)) {
    const key = hookKey(ownerName, file.name);

    // The same path may hold different content than when it was last
    // imported (edit, reinstall at the same path); evict so the import
    // below re-evaluates from disk instead of serving Bun's cached module.
    // No-op for a first-ever load.
    evictModule(file.path);

    try {
      const hook = await importWithTimeout<HookFunction>(file.path);
      if (hook === undefined || typeof hook !== "function") {
        log.error(
          { plugin: ownerName, hook: file.name, path: file.path },
          `hook ${file.name} default export must be a function (got ${typeof hook}) — skipping`,
        );
        continue;
      }
      hookCache.set(key, { hook });
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

/** Test-only: inspect the hook cache's keys. */
export function _inspectHookCacheForTests(): string[] {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "_inspectHookCacheForTests may only be called in test environments",
    );
  }
  return Array.from(hookCache.keys());
}
