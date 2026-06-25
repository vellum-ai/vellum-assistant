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

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { HOOKS } from "../plugin-api/constants.js";
import type {
  HookFunction,
  InitContext,
  ShutdownContext,
} from "../plugin-api/types.js";
import { listSurfaceDir } from "../plugins/external-plugin-loader.js";
import { getMtime, importWithTimeout } from "../plugins/surface-import.js";
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
 * Added and removed hook files are picked up live (discovery is by directory
 * listing). A content edit to an existing file is only reflected after a
 * process restart, since Bun caches dynamic imports by resolved path.
 */
export async function collectUserHooks<TCtx = unknown>(
  hookName: string,
  pluginDirs: Iterable<readonly [string, string]>,
): Promise<HookFunction<TCtx>[]> {
  const out: HookFunction<TCtx>[] = [];

  for (const [pluginDir, pluginName] of pluginDirs) {
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
    if (currentMtime === 0) continue;

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
 */
export async function runInitHook(ownerName: string): Promise<void> {
  const initHookEntry = hookCache.get(hookKey(ownerName, HOOKS.INIT));
  if (initHookEntry === undefined) return;

  try {
    const initContext: InitContext = {
      config: getConfig().plugins?.[ownerName],
      logger: log.child({ plugin: ownerName }),
      pluginStorageDir: ensureHookStorageDir(ownerName),
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
  if (shutdownHookEntry === undefined) return;

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
 * Ensure `<workspaceDir>/plugins-data/<name>/` exists and return its path.
 * Used as the per-owner storage directory in the hook init context.
 */
function ensureHookStorageDir(ownerName: string): string {
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
