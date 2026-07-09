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
 * The filesystem is the source of truth for which hooks exist. The single
 * cache here ({@link hookCache}) only saves repeat filesystem/import work — it
 * is an index over what's on disk, never the source of truth.
 *
 * Each hook is resolved **individually, on demand**, the first time something
 * reads that exact `(owner, hookName)` pair — never a whole directory up front.
 * A resolution memoizes its promise in {@link hookCache}, so the entry doubles
 * as both the cache and the in-flight de-dup (concurrent first-readers of the
 * same hook await one import). The promise resolves to the hook function, or to
 * `null` when the owner doesn't define that hook — a **negative cache** so a
 * hook an owner lacks is stat'd once, not re-stat'd every dispatch. Every hook,
 * dispatch (`user-prompt-submit`, `post-tool-use`, …) *and* lifecycle (`init`,
 * `shutdown`), goes through the one {@link resolveHook} path:
 *
 * - **Dispatch hooks** run on the hot per-turn path via
 *   {@link collectUserHookEntries}, which resolves that one hook name across the
 *   discovered owners; repeat reads are pure map lookups.
 * - **Lifecycle hooks** run once per activation / teardown. {@link runInitHook}
 *   resolves and runs `init`; {@link runShutdownHook} resolves and runs one
 *   owner's `shutdown` for a targeted teardown (uninstall, disable, reload).
 *   Both go through the same resolution, so nothing is pre-warmed.
 *
 * Source changes reach the cache through the source-versions reconcile in
 * `../plugins/mtime-cache.ts`: it evicts the owner ({@link evictHooksForOwner}
 * drops every `(owner, *)` entry, positive and negative) and sweeps the module
 * registry, so the next read re-resolves fresh.
 *
 * Plugin *discovery* (which plugin directories exist, in what order) lives in
 * `../plugins/mtime-cache.ts`; the orchestrator there passes the discovered
 * directories into {@link collectUserHookEntries}. Keeping discovery out of
 * this module lets it sit below the plugin cache with no import cycle.
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

import type { HookEventOwner } from "../api/events/hook-event.js";
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
  importWithTimeout,
  withTimeout,
} from "../plugins/surface-import.js";
import type { HookEntry } from "../plugins/types.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";
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
 * Whether a hook's owner is a user plugin or the standalone workspace surface —
 * the `kind` of a {@link HookEventOwner}, reused so this stays a single source
 * of truth. Threaded into the cache key so the two owner namespaces can't
 * collide even if a plugin's manifest name happens to equal
 * {@link WORKSPACE_HOOKS_OWNER}.
 */
export type HookOwnerKind = HookEventOwner["kind"];

/**
 * Per-hook resolution memo keyed by `${kind}:${ownerName}/${hookName}`. The key
 * includes the owner kind and name (plugin name, or {@link WORKSPACE_HOOKS_OWNER})
 * so hooks from different owners — even a plugin and the workspace that share a
 * name — never collide. Each value is the promise that resolved (or is
 * resolving) that one hook: it settles to the imported function, or to `null`
 * when the owner doesn't define it (a negative cache entry). Storing the
 * promise, not the settled value, means concurrent first-readers of the same
 * hook share one import. An index over the filesystem, never the source of
 * truth.
 */
const hookCache = new Map<string, Promise<HookFunction | null>>();

/** Cache key for a hook: `${kind}:${ownerName}/${hookName}`. */
function hookKey(
  kind: HookOwnerKind,
  ownerName: string,
  hookName: string,
): string {
  return `${kind}:${ownerName}/${hookName}`;
}

/** Key prefix for every hook owned by `(kind, ownerName)`. */
function ownerKeyPrefix(kind: HookOwnerKind, ownerName: string): string {
  return `${kind}:${ownerName}/`;
}

/**
 * The hooks directory an owner's hooks are resolved from, derived purely from
 * `(kind, ownerName)`:
 *
 * - `workspace` → the standalone workspace hooks directory.
 * - `plugin` → `<workspace>/plugins/<ownerName>/hooks`.
 *
 * A plugin's install slug *is* its manifest name (the installer enforces
 * `manifest.name === <install dir basename>`; see
 * `cli/lib/install-from-github.ts`), so the directory is a function of the name
 * alone — no caller needs to thread the plugin directory in.
 */
function ownerHooksDir(kind: HookOwnerKind, ownerName: string): string {
  return kind === "workspace"
    ? getWorkspaceHooksDir()
    : join(getWorkspacePluginsDir(), ownerName, "hooks");
}

/**
 * Resolve a single `(owner, hookName)` to its function, memoized in
 * {@link hookCache}. The first caller starts the import; concurrent callers
 * await the same promise; later callers get a pure map lookup until the owner
 * is evicted. Resolves to `null` when the owner doesn't define the hook — a
 * negative cache entry so an absent hook is looked up once, not every dispatch.
 * This is the single point where hook code enters the process, shared by
 * dispatch reads ({@link collectUserHookEntries}) and lifecycle runs
 * ({@link runInitHook} / {@link runShutdownHook}).
 *
 * The owner's hooks directory is derived from `(kind, ownerName)` via
 * {@link ownerHooksDir} — callers pass only what identifies the owner, never
 * the directory.
 */
function resolveHook(
  kind: HookOwnerKind,
  ownerName: string,
  hookName: string,
): Promise<HookFunction | null> {
  const key = hookKey(kind, ownerName, hookName);
  let entry = hookCache.get(key);
  if (entry === undefined) {
    entry = importHook(ownerHooksDir(kind, ownerName), ownerName, hookName);
    hookCache.set(key, entry);
  }
  return entry;
}

/**
 * Import the file backing `(owner, hookName)` from `hooksDir`, or `null` when
 * the owner doesn't define it (no matching file, a failed import, or a
 * non-function default export). Evicts the module first so an edited file
 * re-evaluates. Never rejects — a failure is logged and cached as `null` like a
 * genuinely absent hook, so one bad file doesn't wedge the resolution promise.
 */
async function importHook(
  hooksDir: string,
  ownerName: string,
  hookName: string,
): Promise<HookFunction | null> {
  const file = listSurfaceDir(hooksDir).find((f) => f.name === hookName);
  if (file === undefined) {
    return null;
  }

  // The same path may hold different content than when it was last imported
  // (edit, reinstall at the same path); evict so the import re-evaluates from
  // disk instead of serving Bun's cached module. No-op for a first-ever load.
  evictModule(file.path);

  try {
    const hook = await importWithTimeout<HookFunction>(file.path);
    if (hook === undefined || typeof hook !== "function") {
      log.error(
        { plugin: ownerName, hook: hookName, path: file.path },
        `hook ${hookName} default export must be a function (got ${typeof hook}) — skipping`,
      );
      return null;
    }
    return hook;
  } catch (err) {
    log.error(
      { err, plugin: ownerName, hook: hookName, path: file.path },
      `Failed to import hook ${hookName} from ${file.path}`,
    );
    return null;
  }
}

/**
 * Collect the hooks for one event name across all surfaces, resolving that one
 * `(owner, hookName)` per owner via {@link resolveHook}. The first read of a
 * given hook does one import; every read after that — until the owner is
 * evicted — is a pure map lookup. Owners without the hook contribute nothing
 * (their negative cache entry keeps them from being re-stat'd).
 *
 * `pluginNames` is the orchestrator's discovered plugin names, in install-date
 * order. Each plugin's hook runs first, then the standalone workspace hook runs
 * last — so a plugin can shape the threaded context before a workspace-wide hook
 * observes or finalizes it. Resolutions are kicked off together and awaited in
 * that order, so a cold first read imports the owners' files concurrently
 * without disturbing chain order. Each owner's hooks directory is derived from
 * its name by {@link resolveHook}, so discovery passes names, not directories.
 *
 * Added, removed, and edited hook files (including helper modules they import)
 * land when the source-versions reconcile evicts the owner and the next read
 * re-resolves.
 *
 * `effectiveEnabledPlugins` carries the per-chat plugin scope: when non-null, a
 * plugin whose name is not in the set is skipped (its hooks do not run for this
 * conversation, and its hook is not imported). The standalone workspace hook is
 * not owned by a plugin, so it always runs. `null`/omitted means no per-chat
 * restriction.
 */
export async function collectUserHookEntries<TCtx = unknown>(
  hookName: string,
  pluginNames: Iterable<string>,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookEntry<TCtx>[]> {
  const pending: Array<{
    owner: HookEntry<TCtx>["owner"];
    hook: Promise<HookFunction | null>;
  }> = [];

  for (const pluginName of pluginNames) {
    if (
      effectiveEnabledPlugins != null &&
      !effectiveEnabledPlugins.has(pluginName)
    ) {
      continue;
    }
    pending.push({
      owner: { kind: "plugin", id: pluginName },
      hook: resolveHook("plugin", pluginName, hookName),
    });
  }

  // Standalone workspace hooks: files directly under `<workspace>/hooks/`
  // that are not part of any plugin (no package.json, no tools — just hooks).
  pending.push({
    owner: { kind: "workspace", id: WORKSPACE_HOOKS_OWNER },
    hook: resolveHook("workspace", WORKSPACE_HOOKS_OWNER, hookName),
  });

  const out: HookEntry<TCtx>[] = [];
  for (const { owner, hook } of pending) {
    const fn = await hook;
    if (fn !== null) {
      out.push({ fn: fn as HookFunction<TCtx>, owner });
    }
  }
  return out;
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
 * Run the `init` hook for `ownerName` if the owner defines one. `init` can't
 * ride the whole-chain `runHook` the way dispatch hooks do because its context
 * is per-plugin (config, logger, storage dir), so it's dispatched per-owner
 * here. Shared by user plugins and standalone workspace hooks so both get the
 * same init-context shape and per-owner isolation (a thrown `init` is logged and
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
  // A plugin always has a directory; only the workspace owner passes `null`.
  const kind: HookOwnerKind = pluginDir === null ? "workspace" : "plugin";

  const initHook = await resolveHook(kind, ownerName, HOOKS.INIT);
  if (initHook === null) {
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

/** How long a single teardown `shutdown` invocation may run before we move on. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Run one owner's `shutdown` — the targeted single-owner teardown for a managed
 * uninstall, disable, or reload (the whole-chain `runHook(HOOKS.SHUTDOWN)` at
 * process exit runs *every* owner's; this runs exactly one). Resolves it through
 * the same {@link resolveHook} the dispatch path uses — cache or disk, so it
 * needs nothing pre-warmed and works in any process (a `shutdown` hook must not
 * assume it shares a process with its `init`; see {@link ShutdownContext}) —
 * then invokes it under the shared {@link withTimeout} so a hook that hangs
 * can't block teardown (e.g. the `rmSync` a managed uninstall runs next). No-op
 * when the owner defines no `shutdown`. Best-effort: a thrown, timed-out, or
 * malformed shutdown is logged and swallowed.
 */
export async function runShutdownHook(
  kind: HookOwnerKind,
  ownerName: string,
  reason: ShutdownContext["reason"],
): Promise<void> {
  const shutdown = await resolveHook(kind, ownerName, HOOKS.SHUTDOWN);
  if (shutdown === null) {
    return;
  }
  const context: ShutdownContext = { assistantVersion: APP_VERSION, reason };
  try {
    await withTimeout(
      Promise.resolve(shutdown(context)),
      SHUTDOWN_TIMEOUT_MS,
      `shutdown hook for ${ownerName} exceeded ${SHUTDOWN_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    log.warn(
      { err, plugin: ownerName, reason },
      "user hooks shutdown failed or timed out (continuing)",
    );
  }
}

/**
 * Evict every cached resolution owned by `(kind, ownerName)` — positive and
 * negative — so the next read re-resolves fresh. Called by the reconcile after
 * the owner's `shutdown` has already run. No-op when the owner has no cached
 * state.
 */
export function evictHooksForOwner(
  kind: HookOwnerKind,
  ownerName: string,
): void {
  const prefix = ownerKeyPrefix(kind, ownerName);
  for (const key of hookCache.keys()) {
    if (key.startsWith(prefix)) {
      hookCache.delete(key);
    }
  }
}

/**
 * Evict all plugin-owned resolutions while preserving standalone workspace
 * hooks. Called when the plugins directory is gone entirely: workspace hooks
 * live outside it, so the absence of any plugin must not evict them.
 */
export function clearPluginHooks(): void {
  for (const key of hookCache.keys()) {
    if (key.startsWith("plugin:")) {
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

/** Clear the hook resolution cache. Test-only. */
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
