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
 * The filesystem is the source of truth for which hooks exist; the caches
 * here only save repeat filesystem/import work. Two surfaces, cached
 * differently by how often they run:
 *
 * - **Dispatch hooks** (`user-prompt-submit`, `post-tool-use`, `stop`, …) run
 *   on the hot per-turn path. They are imported **lazily**, the first time
 *   {@link collectUserHookEntries} reads an owner, into {@link hookCache} —
 *   never at startup. An owner is imported as a unit (all its dispatch hooks
 *   at once) so that a hook the owner doesn't define is a negative cache hit,
 *   not a per-dispatch re-stat. Repeat reads are pure map lookups.
 * - **Lifecycle hooks** (`init`, `shutdown`) run once per activation /
 *   teardown. {@link runInitHook} imports and runs `init` and captures the
 *   owner's `shutdown` into {@link shutdownHooks}, so teardown can run it even
 *   after an uninstall has removed the directory.
 *
 * Source changes reach these caches through the source-versions reconcile in
 * `../plugins/mtime-cache.ts`: it evicts the owner ({@link evictHooksForOwner}
 * clears both caches and the loaded mark) and sweeps the module registry, so
 * the next read re-imports fresh.
 *
 * Plugin *discovery* (which plugin directories exist, in what order) lives in
 * `../plugins/mtime-cache.ts`; the orchestrator there passes the discovered
 * directories into {@link collectUserHooks}. Keeping discovery out of this
 * module lets it sit below the plugin cache with no import cycle.
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

/** A cached, imported dispatch hook function. */
interface CachedHook {
  readonly hook: HookFunction;
}

/**
 * Lazily-imported dispatch hooks keyed by `${ownerName}/${hookName}`. The key
 * includes the owner (plugin name, or {@link WORKSPACE_HOOKS_OWNER}) so hooks
 * from different owners don't collide. Populated per-owner on first read; a
 * pure fs-op cache, never the source of truth.
 */
const hookCache = new Map<string, CachedHook>();

/**
 * Owners whose dispatch hooks have been imported into {@link hookCache}.
 * Distinguishes "this owner defines no `<hookName>`" (loaded, absent — a
 * negative cache hit) from "not imported yet" (needs a load).
 */
const loadedOwners = new Set<string>();

/**
 * Captured `shutdown` hooks keyed by owner, populated at activation by
 * {@link runInitHook}. Held separately from {@link hookCache} because
 * teardown must be able to run an owner's `shutdown` after its directory is
 * gone (uninstall) — the function has to already be resident, so it can't be
 * resolved from disk at teardown time.
 */
const shutdownHooks = new Map<string, HookFunction>();

/** Cache key for a hook: `${ownerName}/${hookName}`. */
function hookKey(ownerName: string, hookName: string): string {
  return `${ownerName}/${hookName}`;
}

/**
 * The hooks directory for an owner: `<pluginDir>/hooks` for a plugin, or the
 * standalone workspace hooks directory for {@link WORKSPACE_HOOKS_OWNER}
 * (whose `pluginDir` is `null`).
 */
function ownerHooksDir(pluginDir: string | null): string {
  return pluginDir === null ? getWorkspaceHooksDir() : join(pluginDir, "hooks");
}

/**
 * Import a single hook file for `hookName` from `hooksDir`, or `undefined`
 * when the owner doesn't define it (or the import fails / isn't a function).
 * Evicts first so a changed file re-evaluates. Does not touch {@link hookCache}
 * — used for lifecycle hooks, which are loaded on their own schedule.
 */
async function importOneHook(
  hooksDir: string,
  ownerName: string,
  hookName: string,
): Promise<HookFunction | undefined> {
  const file = listSurfaceDir(hooksDir).find((f) => f.name === hookName);
  if (file === undefined) {
    return undefined;
  }
  evictModule(file.path);
  try {
    const hook = await importWithTimeout<HookFunction>(file.path);
    if (hook === undefined || typeof hook !== "function") {
      log.error(
        { plugin: ownerName, hook: hookName, path: file.path },
        `hook ${hookName} default export must be a function (got ${typeof hook}) — skipping`,
      );
      return undefined;
    }
    return hook;
  } catch (err) {
    log.error(
      { err, plugin: ownerName, hook: hookName, path: file.path },
      `Failed to import hook ${hookName} from ${file.path}`,
    );
    return undefined;
  }
}

/**
 * Ensure an owner's dispatch hooks are imported into {@link hookCache}. The
 * first call for an owner imports its whole `hooks/` directory (so absent
 * hooks become negative cache hits); later calls are no-ops until the owner
 * is evicted. This is the lazy fill behind {@link collectUserHookEntries}.
 */
async function ensureOwnerHooksLoaded(
  hooksDir: string,
  ownerName: string,
): Promise<void> {
  if (loadedOwners.has(ownerName)) {
    return;
  }
  loadedOwners.add(ownerName);
  await preImportHooksDir(hooksDir, ownerName);
}

/**
 * Collect every hook for a given event name across all surfaces, importing
 * each owner's dispatch hooks lazily on first read (see
 * {@link ensureOwnerHooksLoaded}). The first read of an owner does one
 * directory import; every read after that — until the owner is evicted — is a
 * pure map lookup.
 *
 * `pluginDirs` is the orchestrator's discovered `[dir, ownerName]` set (in
 * install-date order). Each plugin's hook runs first, then the standalone
 * workspace hook runs last — so a plugin can shape the threaded context
 * before a workspace-wide hook observes or finalizes it.
 *
 * The cache holds exactly what each owner's last import saw on disk; added,
 * removed, and edited hook files (including helper modules they import) land
 * when the source-versions reconcile evicts the owner and the next read
 * re-imports.
 *
 * `effectiveEnabledPlugins` carries the per-chat plugin scope: when non-null, a
 * plugin whose name is not in the set is skipped (its hooks do not run for this
 * conversation, and its hooks are not imported). The standalone workspace hook
 * is not owned by a plugin, so it always runs. `null`/omitted means no per-chat
 * restriction.
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
    await ensureOwnerHooksLoaded(ownerHooksDir(pluginDir), pluginName);
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
  await ensureOwnerHooksLoaded(ownerHooksDir(null), WORKSPACE_HOOKS_OWNER);
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
 * Import and run the `init` hook for `ownerName` if the owner defines one, and
 * capture its `shutdown` into {@link shutdownHooks} for later teardown. Both
 * lifecycle hooks are imported directly here (not through the lazy dispatch
 * cache), since activation happens before any dispatch read. Shared by user
 * plugins and standalone workspace hooks so both get the same init-context
 * shape and per-owner isolation (a thrown `init` is logged and swallowed,
 * never blocking boot).
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
  const hooksDir = ownerHooksDir(pluginDir);

  // Capture the owner's `shutdown` now, while its directory is still present,
  // so teardown can run it even after an uninstall removes the directory
  // ({@link runShutdownHook} reads from {@link shutdownHooks}, never disk).
  const shutdown = await importOneHook(hooksDir, ownerName, HOOKS.SHUTDOWN);
  if (shutdown !== undefined) {
    shutdownHooks.set(ownerName, shutdown);
  }

  const initHook = await importOneHook(hooksDir, ownerName, HOOKS.INIT);
  if (initHook === undefined) {
    return;
  }

  try {
    const initContext: InitContext = {
      config: resolvePluginConfig(ownerName, pluginDir),
      logger: log.child({ plugin: ownerName }),
      pluginStorageDir: resolvePluginStorageDir(ownerName, pluginDir),
      assistantVersion: APP_VERSION,
    };
    await initHook(initContext);
    log.info({ plugin: ownerName }, "user hooks initialized");
  } catch (err) {
    log.error(
      { err, plugin: ownerName },
      `User hooks for ${ownerName} init() failed — continuing`,
    );
  }
}

/**
 * Run the `shutdown` hook for `ownerName` if one was captured at activation.
 * Reads from {@link shutdownHooks} (never disk), so it works even after an
 * uninstall has removed the owner's directory. Best-effort: a thrown shutdown
 * is logged and swallowed. The capture is dropped afterward — shutdown is
 * terminal for an activation; a reload re-captures it when `init` runs again.
 * `reason` is threaded into the log for attribution only.
 */
export async function runShutdownHook(
  ownerName: string,
  context: ShutdownContext,
  reason: string,
): Promise<void> {
  const shutdown = shutdownHooks.get(ownerName);
  if (shutdown === undefined) {
    return;
  }

  try {
    await shutdown(context);
  } catch (err) {
    log.warn(
      { err, plugin: ownerName, reason },
      "user hooks shutdown failed (continuing)",
    );
  } finally {
    shutdownHooks.delete(ownerName);
  }
}

/**
 * Evict every trace of `ownerName` from all three caches — dispatch hooks
 * ({@link hookCache}), the loaded mark ({@link loadedOwners}), and the captured
 * `shutdown` ({@link shutdownHooks}) — so the next read re-imports fresh. Called
 * by the reconcile after the owner's `shutdown` has already run, so dropping the
 * capture here never skips teardown. No-op when the owner has no state.
 */
export function evictHooksForOwner(ownerName: string): void {
  const prefix = `${ownerName}/`;
  for (const key of hookCache.keys()) {
    if (key.startsWith(prefix)) {
      hookCache.delete(key);
    }
  }
  loadedOwners.delete(ownerName);
  shutdownHooks.delete(ownerName);
}

/**
 * Evict all plugin-owned hook state while preserving standalone workspace
 * hooks. Called when the plugins directory is gone entirely: workspace hooks
 * live outside it, so the absence of any plugin must not evict them.
 */
export function clearPluginHooks(): void {
  for (const key of hookCache.keys()) {
    if (!key.startsWith(`${WORKSPACE_HOOKS_OWNER}/`)) {
      hookCache.delete(key);
    }
  }
  for (const owner of loadedOwners) {
    if (owner !== WORKSPACE_HOOKS_OWNER) {
      loadedOwners.delete(owner);
    }
  }
  for (const owner of shutdownHooks.keys()) {
    if (owner !== WORKSPACE_HOOKS_OWNER) {
      shutdownHooks.delete(owner);
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

/** Clear every hook cache (dispatch, loaded marks, captured shutdowns). Test-only. */
export function resetHookCacheForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "resetHookCacheForTests may only be called in test environments",
    );
  }
  hookCache.clear();
  loadedOwners.clear();
  shutdownHooks.clear();
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
