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
 * - Boot does one full discovery scan; after that, every change (plugin
 *   installed, removed, disabled, or any source file inside a plugin edited
 *   — including helper modules hooks/tools import) arrives through the
 *   source-versions sentinel published by the resource monitor's watcher.
 *   The dispatch path stats that one file and otherwise runs on memory.
 * - A changed plugin is redeployed in place: the old version's `shutdown`
 *   runs, its hook/tool cache entries and module-registry entries are
 *   swept, and reactivation re-imports fresh source and runs `init`. The
 *   whole directory is the reload unit so a re-imported hook can never pair
 *   with a stale cached helper.
 * - Plugins are never "registered" as a unit — we register their tools into
 *   the global tool registry.
 *
 * The cache is populated at boot by `loadUserPlugins()`; `getHooksFor`
 * reads it on every dispatch via {@link getUserHookEntriesFor}.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  clearPluginHooks,
  collectUserHookEntries,
  evictHooksForOwner,
  hasWorkspaceHooks,
  preImportHooksDir,
  preImportWorkspaceHooks,
  resetHookCacheForTests,
  runInitHook,
  runShutdownHook,
  WORKSPACE_HOOKS_OWNER,
} from "../hooks/hook-loader.js";
import type { HookFunction, ShutdownReason } from "../plugin-api/types.js";
import {
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolDefinition } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import {
  deriveToolName,
  listSurfaceDir,
  parsePluginManifest,
} from "./external-plugin-loader.js";
import { snapshotPluginSource } from "./source-fingerprint.js";
import type { PluginSourceVersion } from "./source-versions.js";
import {
  getSourceVersionsPath,
  readSourceVersions,
} from "./source-versions.js";
import {
  clearSurfaceImportInflight,
  evictModule,
  getMtime,
  importWithTimeout,
  setSurfaceImportTimeout,
} from "./surface-import.js";
import type { HookEntry } from "./types.js";

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
  if (cached !== undefined) {
    return cached;
  }

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
 * The source-versions state this process last applied, keyed by directory
 * (see `./source-versions.ts`). Seeded at boot from the daemon's own walk —
 * the same fingerprint algorithm over the same disk yields the same stamps
 * as the watcher, so the first sentinel publication after boot diffs
 * correctly even against edits made while the daemon was down.
 */
let lastVersions: Record<string, PluginSourceVersion> = {};

/** mtime of the sentinel document as of the last look; 0 = never seen. */
let lastSentinelMtime = 0;

/** In-flight reconcile — concurrent dispatches await it rather than racing. */
let reconcileInFlight: Promise<void> | null = null;

// ─── Hook reads ──────────────────────────────────────────────────────────────

/**
 * Get all hooks for a given event name from user plugins and standalone
 * workspace hooks. Checks the source-versions sentinel first (one stat;
 * reconciles only when the watcher published a change), then delegates to
 * the hook loader's in-memory cache. Plugin hooks run in install-date
 * order, the workspace hook runs last.
 *
 * `effectiveEnabledPlugins` carries the per-chat plugin scope: when non-null,
 * user plugins outside the set are skipped (standalone workspace hooks always
 * run). `null`/omitted means no per-chat restriction.
 */
export async function getUserHookEntriesFor<TCtx = unknown>(
  hookName: string,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookEntry<TCtx>[]> {
  await maybeReconcileFromSentinel();
  return collectUserHookEntries<TCtx>(
    hookName,
    discoveredPluginDirs,
    effectiveEnabledPlugins,
  );
}

/**
 * {@link getUserHookEntriesFor} without owner attribution — returns just the
 * hook functions in the same order.
 */
export async function getUserHooksFor<TCtx = unknown>(
  hookName: string,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookFunction<TCtx>[]> {
  const entries = await getUserHookEntriesFor<TCtx>(
    hookName,
    effectiveEnabledPlugins,
  );
  return entries.map((e) => e.fn);
}

// ─── Source-versions reconcile ───────────────────────────────────────────────

/**
 * Dispatch-path gate: one stat of the source-versions sentinel. When its
 * mtime is unchanged since the last look (the overwhelmingly common case)
 * this returns immediately, and dispatch runs entirely on memory. When the
 * watcher published a change, the document is applied before the dispatch
 * proceeds, so the turn that follows an edit already runs the new code.
 *
 * A missing or unreadable sentinel is degraded mode, not an error: the
 * boot-time state keeps serving, and live reload resumes when the monitor
 * publishes again.
 */
async function maybeReconcileFromSentinel(): Promise<void> {
  if (reconcileInFlight !== null) {
    await reconcileInFlight;
    return;
  }
  const mtime = getMtime(getSourceVersionsPath());
  if (mtime === lastSentinelMtime) {
    return;
  }
  // Claim the mtime before any async work, so a concurrent dispatch either
  // finds the in-flight promise above or skips on the updated mtime.
  lastSentinelMtime = mtime;
  if (mtime === 0) {
    return;
  }
  const doc = readSourceVersions();
  if (doc === null) {
    return;
  }
  reconcileInFlight = applySourceVersions(doc.plugins).finally(() => {
    reconcileInFlight = null;
  });
  await reconcileInFlight;
}

/**
 * Validate that a directory path from the sentinel is an allowed plugin
 * source: either under the workspace plugins directory or the standalone
 * workspace hooks directory. The sentinel file lives under
 * `<workspace>/data/monitoring/` which is not protected by the file-risk
 * classifier, so a forged sentinel could point at arbitrary directories
 * containing attacker-controlled TypeScript. This check ensures
 * `bringUpPlugin` never dynamically imports code from outside the
 * designated plugin roots, regardless of what the sentinel contains.
 *
 * Uses `realpathSync` to resolve symlinks before the prefix check, so a
 * symlinked path that looks like it's under the plugins dir but points
 * elsewhere is rejected.
 */
function isAllowedPluginDir(dir: string, pluginsDir: string, hooksDir: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch {
    // Directory doesn't exist or is inaccessible — allow it through so
    // bringUpPlugin/parsePluginManifest can log the normal failure. The
    // danger is importing code from an unexpected location, not a missing
    // directory.
    return true;
  }
  const normalizedPluginsDir = pluginsDir + "/";
  const normalizedHooksDir = hooksDir + "/";
  return (
    resolved === pluginsDir ||
    resolved.startsWith(normalizedPluginsDir) ||
    resolved === hooksDir ||
    resolved.startsWith(normalizedHooksDir)
  );
}

/**
 * Apply a published source-versions map: diff it against the state last
 * applied and redeploy exactly what changed. Never throws — a failed apply
 * is logged and the next publication retries from the sentinel's truth.
 *
 * Per directory, the transitions are:
 * - present + enabled with a moved fingerprint → in-place redeploy:
 *   `shutdown` (reason `reload`) → sweep hook/tool caches and the module
 *   registry → re-import, re-register tools, `init`. The whole directory is
 *   the reload unit on purpose: partial eviction would let a re-imported
 *   hook pair with a stale cached helper, silently mixing versions.
 * - newly present (installed, or `.disabled` removed) → bring up.
 * - gone, or newly disabled → tear down (`uninstall` / `disable`).
 * The workspace hooks pseudo-entry gets the same treatment through its own
 * `init`/`shutdown` lifecycle.
 */
async function applySourceVersions(
  next: Readonly<Record<string, PluginSourceVersion>>,
): Promise<void> {
  try {
    const workspaceHooksDir = getWorkspaceHooksDir();
    const pluginsDir = getWorkspacePluginsDir();
    const prev = lastVersions;
    const dirs = new Set([...Object.keys(prev), ...Object.keys(next)]);
    let membershipChanged = false;

    for (const dir of dirs) {
      if (dir === workspaceHooksDir) {
        continue;
      }
      // Reject directories from the sentinel that are outside the allowed
      // plugin roots. A forged sentinel could point at arbitrary paths;
      // without this check, bringUpPlugin would dynamic-import attacker
      // code from anywhere on the filesystem.
      if (!isAllowedPluginDir(dir, pluginsDir, workspaceHooksDir)) {
        log.warn(
          { dir },
          "sentinel references directory outside allowed plugin roots — skipping",
        );
        continue;
      }
      const before = prev[dir];
      const after = next[dir];
      const activeName = discoveredPluginDirs.get(dir);
      const shouldBeUp = after !== undefined && !after.disabled;

      if (activeName !== undefined && !shouldBeUp) {
        const reason: ShutdownReason =
          after === undefined ? "uninstall" : "disable";
        await deactivatePlugin(activeName, reason);
        await evictPlugin(dir, activeName);
        sweepModules(before, after);
        membershipChanged = true;
      } else if (activeName === undefined && shouldBeUp) {
        // Reinstalls land at the same path: sweep any modules cached from a
        // prior install before the fresh import.
        sweepModules(before, after);
        if (await bringUpPlugin(dir)) {
          membershipChanged = true;
        }
      } else if (
        activeName !== undefined &&
        before !== undefined &&
        after !== undefined &&
        before.fingerprint !== after.fingerprint
      ) {
        log.info(
          { plugin: activeName, dir },
          "plugin source changed — reloading",
        );
        // Shutdown reads the old version's hook from the cache, so it must
        // run before the hook cache is cleared.
        await deactivatePlugin(activeName, "reload");
        evictHooksForOwner(activeName);
        evictToolCacheEntries(activeName);
        sweepModules(before, after);
        // Re-read the manifest — the edit may have renamed the plugin (or
        // broken the manifest, in which case the plugin stays down until a
        // later edit fixes it and moves the fingerprint again).
        const manifest = await parsePluginManifest(dir);
        if (manifest === undefined) {
          discoveredPluginDirs.delete(dir);
          membershipChanged = true;
        } else {
          if (manifest.name !== activeName) {
            discoveredPluginDirs.set(dir, manifest.name);
            membershipChanged = true;
          }
          await reconcilePluginTools(dir, manifest.name);
          await activatePlugin(dir, manifest.name);
        }
      }
    }

    if (membershipChanged) {
      sortDiscoveredPluginDirs();
    }

    await reconcileWorkspaceHooks(
      prev[workspaceHooksDir],
      next[workspaceHooksDir],
    );

    lastVersions = { ...next };
  } catch (err) {
    log.error(
      { err },
      "source-versions reconcile failed — keeping current state",
    );
  }
}

/**
 * Bring up a directory the sentinel reports as present and enabled. Returns
 * whether the plugin joined the discovered set (a malformed manifest is
 * logged by the parser and the directory is skipped until it changes again).
 */
async function bringUpPlugin(dir: string): Promise<boolean> {
  const manifest = await parsePluginManifest(dir);
  if (manifest === undefined) {
    return false;
  }
  discoveredPluginDirs.set(dir, manifest.name);
  disabledPluginDirs.delete(dir);
  log.info({ plugin: manifest.name, dir }, "plugin discovered");
  await reconcilePluginTools(dir, manifest.name);
  await activatePlugin(dir, manifest.name);
  return true;
}

/**
 * Evict the union of two version entries' module paths from the module
 * registry, so re-imports re-evaluate a mutually consistent set (deleted
 * files may still be cached — hence the union, not just the new list).
 */
function sweepModules(
  before: PluginSourceVersion | undefined,
  after: PluginSourceVersion | undefined,
): void {
  const paths = new Set([
    ...(before?.evictionPaths ?? []),
    ...(after?.evictionPaths ?? []),
  ]);
  for (const path of paths) {
    evictModule(path);
  }
}

/**
 * Reconcile the standalone workspace hooks pseudo-entry: same
 * shutdown → sweep → re-import → init cycle a plugin gets, through the
 * workspace owner's lifecycle.
 */
async function reconcileWorkspaceHooks(
  before: PluginSourceVersion | undefined,
  after: PluginSourceVersion | undefined,
): Promise<void> {
  if (before?.fingerprint === after?.fingerprint) {
    return;
  }
  const reason: ShutdownReason = after === undefined ? "uninstall" : "reload";
  const activeIdx = activatedPlugins.findIndex(
    (p) => p.name === WORKSPACE_HOOKS_OWNER,
  );
  if (activeIdx >= 0) {
    await runShutdownHook(
      WORKSPACE_HOOKS_OWNER,
      { assistantVersion: APP_VERSION, reason },
      reason,
    );
    activatedPlugins.splice(activeIdx, 1);
  }
  evictHooksForOwner(WORKSPACE_HOOKS_OWNER);
  sweepModules(before, after);
  if (after !== undefined) {
    await preImportWorkspaceHooks();
    await runInitHook(WORKSPACE_HOOKS_OWNER);
    activatedPlugins.push({ name: WORKSPACE_HOOKS_OWNER });
    log.info("workspace hooks reloaded");
  }
}

/**
 * Seed the reconcile baseline at boot from the daemon's own walk, and record
 * the sentinel's current mtime without applying its content. Both sides run
 * the same fingerprint algorithm over the same disk, so the seed matches
 * whatever a healthy watcher would publish for the state boot just loaded —
 * and the first publication that differs (including edits made while the
 * daemon was down, which the watcher detects against its own adopted state)
 * diffs correctly against it.
 */
function seedVersionBaseline(): void {
  const seeded: Record<string, PluginSourceVersion> = {};
  for (const [dir] of discoveredPluginDirs) {
    const snapshot = snapshotPluginSource(dir);
    seeded[dir] = {
      fingerprint: snapshot.fingerprint,
      evictionPaths: snapshot.evictionPaths,
      disabled: false,
    };
  }
  const workspaceHooksDir = getWorkspaceHooksDir();
  if (existsSync(workspaceHooksDir)) {
    const snapshot = snapshotPluginSource(workspaceHooksDir);
    seeded[workspaceHooksDir] = {
      fingerprint: snapshot.fingerprint,
      evictionPaths: snapshot.evictionPaths,
      disabled: false,
    };
  }
  lastVersions = seeded;
  lastSentinelMtime = getMtime(getSourceVersionsPath());
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
    if (cachedPluginName !== pluginName) {
      continue;
    }
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
 * Runs once at boot ({@link populateCacheAtBoot}); steady-state changes —
 * installs, removals, disables, and source edits — arrive through the
 * source-versions reconcile instead, so the dispatch path never pays for
 * this walk.
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
      if (!statSync(pluginDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (!existsSync(join(pluginDir, "package.json"))) {
      continue;
    }

    // Check for the .disabled sentinel. A plugin is disabled when a file
    // named `.disabled` exists inside its plugin directory. Disabled
    // plugins are skipped entirely — no hooks, no tools, no cache entries.
    // If the plugin was previously active, its cache entries are evicted.
    if (existsSync(join(pluginDir, ".disabled"))) {
      const manifest = await parsePluginManifest(pluginDir);
      const pluginName = manifest?.name ?? entry;
      if (discoveredPluginDirs.has(pluginDir)) {
        await deactivatePlugin(pluginName, "disable");
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
    if (manifest === undefined) {
      continue;
    }
    const { name: pluginName } = manifest;

    currentDirs.set(pluginDir, pluginName);
    disabledPluginDirs.delete(pluginDir);

    if (!discoveredPluginDirs.has(pluginDir)) {
      log.info({ plugin: pluginName, pluginDir }, "plugin discovered");
    }

    // Reconcile this plugin's tools (re-imports changed files).
    await reconcilePluginTools(pluginDir, pluginName);
  }

  // Deactivate and evict cache entries for deleted plugins.
  for (const [pluginDir, pluginName] of discoveredPluginDirs) {
    if (!currentDirs.has(pluginDir)) {
      await deactivatePlugin(pluginName, "uninstall");
      await evictPlugin(pluginDir, pluginName);
    }
  }

  // Update the discovered set, sorted by original install date so
  // hook execution order and tool registration order are deterministic.
  discoveredPluginDirs.clear();
  for (const [dir, name] of currentDirs) {
    discoveredPluginDirs.set(dir, name);
  }
  sortDiscoveredPluginDirs();

  // Activate any plugin not yet brought up. Idempotent: already-active plugins
  // are skipped by the `activatedNames` guard, so steady-state scans (one per
  // hook dispatch) cost only a membership check per plugin. Tools were imported
  // into `toolCache` by `reconcilePluginTools` above, so they are ready to
  // register here.
  for (const [dir, name] of discoveredPluginDirs) {
    await activatePlugin(dir, name);
  }
}

/**
 * Re-sort the discovered set by original install date, so hook execution
 * order and tool registration order stay deterministic as membership
 * changes at runtime.
 */
function sortDiscoveredPluginDirs(): void {
  const sorted = [...discoveredPluginDirs.entries()].sort(
    ([dirA], [dirB]) => getInstallDate(dirA) - getInstallDate(dirB),
  );
  discoveredPluginDirs.clear();
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
  evictToolCacheEntries(pluginName);

  log.info(
    { plugin: pluginName, pluginDir },
    "plugin evicted (directory removed)",
  );
  discoveredPluginDirs.delete(pluginDir);
  installDateCache.delete(pluginDir);
}

/** Drop every `toolCache` entry owned by `pluginName`. */
function evictToolCacheEntries(pluginName: string): void {
  const toolPrefix = `${pluginName}/`;
  for (const key of toolCache.keys()) {
    if (key.startsWith(toolPrefix)) {
      toolCache.delete(key);
    }
  }
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

// ─── Activation lifecycle ────────────────────────────────────────────────────

/**
 * Plugins (and the workspace-hooks pseudo-owner) fully activated (tools
 * registered + `init` hook run) within this process, in activation order. A
 * runtime uninstall/disable tears a single entry down via
 * {@link deactivatePlugin}; at daemon shutdown the owners' `shutdown` hooks
 * fire through the unified `runHook(HOOKS.SHUTDOWN)` pipeline.
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

/**
 * Activate a single discovered plugin: pre-import its hooks, register its tools
 * into the global tool registry, and run its `init` hook. Idempotent — a plugin
 * already activated (or mid-activation) is skipped. Never throws; per-surface
 * failures are logged and the plugin still counts as activated so the shutdown
 * teardown handles whatever came up (mirrors boot semantics).
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
    return;
  }
  // Reserve synchronously, before any await, so a re-entrant or concurrent
  // scan observes this plugin as already handled.
  activatedNames.add(pluginName);

  // Pre-import all hooks so the first dispatch doesn't pay the import cost.
  await preImportHooksDir(join(pluginDir, "hooks"), pluginName);

  // Register this plugin's tools into the global tool registry so
  // `getAllTools()` and `getTool()` can find them. Tools were already imported
  // and cached by `reconcilePluginTools` during the scan.
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
  await runInitHook(pluginName, pluginDir);

  activatedPlugins.push({ name: pluginName });
}

/**
 * Deactivate a plugin whose directory was removed (`uninstall`) or disabled
 * (`disable`) at runtime: unregister its tools and run its `shutdown` hook with
 * the matching {@link ShutdownReason}. Must run *before* `evictPlugin` clears
 * the hook cache, since the shutdown hook is read from it. Idempotent — a plugin
 * that was never activated is a no-op.
 */
async function deactivatePlugin(
  pluginName: string,
  reason: ShutdownReason,
): Promise<void> {
  if (!activatedNames.has(pluginName)) {
    return;
  }
  activatedNames.delete(pluginName);
  const idx = activatedPlugins.findIndex((p) => p.name === pluginName);
  if (idx >= 0) {
    activatedPlugins.splice(idx, 1);
  }

  // Unregister tools before running shutdown so the model-visible surface is
  // clean before teardown.
  try {
    unregisterPluginTools(pluginName);
  } catch (err) {
    log.warn(
      { err, plugin: pluginName },
      "user plugin tool unregister failed (continuing)",
    );
  }

  await runShutdownHook(
    pluginName,
    { assistantVersion: APP_VERSION, reason },
    reason,
  );
}

// ─── Boot population ─────────────────────────────────────────────────────────

/**
 * Populate the caches at boot by scanning the plugins directory once (which
 * imports surfaces, registers tools, and runs `init` hooks via `activatePlugin`
 * inside `scanPlugins`) and activating standalone workspace hooks. At daemon
 * shutdown these owners' `shutdown` hooks fire through the unified
 * `runHook(HOOKS.SHUTDOWN)` pipeline; a runtime uninstall/disable tears a single
 * owner down via {@link deactivatePlugin}.
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

  // Boot is self-sufficient (the scan above never waits on the monitor);
  // from here on, changes arrive via the sentinel diffed against this seed.
  seedVersionBaseline();
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
  activatedNames.clear();
  disabledPluginDirs.clear();
  lastVersions = {};
  lastSentinelMtime = 0;
  reconcileInFlight = null;
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
