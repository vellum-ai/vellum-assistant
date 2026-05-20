/**
 * Filesystem watcher for the external plugins directory.
 *
 * Watches `<workspaceDir>/plugins/` recursively using fs.watch (FSEvents on
 * macOS). When a plugin directory is created or modified, debounces per
 * top-level directory name (= the plugin name) and dispatches to the
 * watcher's internal change handler so the daemon can register or reload
 * the plugin without a restart.
 *
 * Mirrors `app-source-watcher.ts` (same DebouncerMap shape, same start/stop
 * lifecycle, same ensureStarted late-create hook), but exposes its lifecycle
 * through a static singleton so tool side-effects can call
 * `PluginSourceWatcher.getInstance().ensureStarted()` directly without an
 * intermediate module-level injection.
 *
 * ## Linux/Bun recursive-watch caveat
 *
 * `fs.watch(dir, { recursive: true })` on Linux (and the equivalent under
 * Bun, which uses the platform inotify path) does **not** dynamically
 * attach to subdirectories created after the watch was established. The
 * kernel fires exactly one event when the new top-level entry appears,
 * and any writes inside that new subtree are silently dropped.
 *
 * Reproducer (against an empty watched root):
 *
 *     mkdir plugin/                      → event "plugin"
 *     mkdir plugin/hooks/                → no event delivered
 *     echo x > plugin/hooks/file.ts      → no event delivered
 *
 * To work around this we close + reopen the watcher on every event (with
 * a coalescing debounce). Reopening walks the tree from scratch and
 * re-subscribes to every directory that currently exists, so subsequent
 * writes anywhere under the new subtree are delivered normally. We also
 * rescan top-level entries after the swap and dispatch a rebuild for any
 * plugin not yet in the registry, which closes the close→reopen gap.
 */

import { type FSWatcher, mkdirSync, readdirSync, watch } from "node:fs";

import { getRegisteredPlugin } from "../plugins/registry.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { reregisterExternalPlugin } from "./external-plugins-bootstrap.js";

const log = getLogger("plugin-source-watcher");

const PLUGIN_SOURCE_DEBOUNCE_MS = 500;

/**
 * Single shared debouncer key for the "restart the watcher" path. Bursty
 * events for many plugin names all collapse to one restart.
 */
const WATCHER_RESTART_KEY = "__restart__";

/**
 * Extract the plugin's top-level directory name from a relative path within
 * the plugins root. Returns null for a stray file directly in `plugins/`
 * (not a plugin dir).
 */
function resolvePluginNameFromRelPath(relPath: string): string | null {
  const slashIdx = relPath.indexOf("/");
  if (slashIdx === -1) {
    // Bare entry under plugins/ — fs.watch reports these when a new
    // directory is first created. We treat the name as the plugin name and
    // let the install path decide whether it's a real plugin.
    if (relPath.length === 0 || relPath.startsWith(".")) return null;
    return relPath;
  }
  const dirName = relPath.slice(0, slashIdx);
  if (dirName.length === 0 || dirName.startsWith(".")) return null;
  return dirName;
}

export class PluginSourceWatcher {
  /**
   * Process-wide singleton. Callers reach the watcher via
   * {@link PluginSourceWatcher.getInstance} rather than instantiating
   * directly so tool side-effects (`assistant plugins install`) can call
   * `ensureStarted()` on the same watcher the daemon `start()`/`stop()`
   * lifecycle owns, without threading an instance through a registered
   * module-level callback.
   */
  private static singleton: PluginSourceWatcher | null = null;

  static getInstance(): PluginSourceWatcher {
    PluginSourceWatcher.singleton ??= new PluginSourceWatcher();
    return PluginSourceWatcher.singleton;
  }

  /** Test-only — drops the singleton so the next `getInstance()` rebuilds. */
  static resetForTests(): void {
    PluginSourceWatcher.singleton?.stop();
    PluginSourceWatcher.singleton = null;
  }

  private watcher: FSWatcher | null = null;
  private started = false;
  private debouncer = new DebouncerMap({
    defaultDelayMs: PLUGIN_SOURCE_DEBOUNCE_MS,
    maxEntries: 50,
  });
  /**
   * Coalesces watcher-restart requests across bursty events. See
   * {@link restartWatcher} for why we restart on every event.
   */
  private restartDebouncer = new DebouncerMap({
    defaultDelayMs: PLUGIN_SOURCE_DEBOUNCE_MS,
    maxEntries: 1,
  });

  start(): void {
    this.started = true;
    this.tryWatch();
  }

  /**
   * Ensure the watcher is running. Idempotent — safe to call after a tool
   * side-effect that may have just created the plugins directory.
   * No-op if `start()` has not been called yet.
   */
  ensureStarted(): void {
    if (!this.started || this.watcher) return;
    this.tryWatch();
  }

  stop(): void {
    this.started = false;
    this.debouncer.cancelAll();
    this.restartDebouncer.cancelAll();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private onChange(pluginName: string): Promise<void> {
    return reregisterExternalPlugin(pluginName);
  }

  /**
   * Close the current FSWatcher and open a fresh one on the same root.
   *
   * Workaround for the Linux/Bun recursive-watch limitation documented at
   * the top of this file. Reopening re-walks the tree and re-subscribes
   * to every directory that exists at that moment, including any subtree
   * that grew under the watched root since the previous watcher started.
   *
   * Belt-and-suspenders: after the swap, we rescan top-level entries and
   * dispatch a rebuild for any plugin not yet in the registry — this
   * closes the (sub-millisecond) gap between close and reopen during
   * which a brand-new plugin's first event could be lost.
   *
   * Failure mode: if the reopen fails, keep the previous watcher active.
   * It may still miss newly-created subtrees, but it preserves existing
   * plugin source coverage instead of degrading to no watcher at all.
   */
  private restartWatcher(): void {
    if (!this.started) return;

    const oldWatcher = this.watcher;
    this.watcher = null; // tryWatch returns early when non-null
    this.tryWatch();

    if (this.watcher === null) {
      // Keep the previous watcher alive if the replacement failed. It may not
      // cover newly-created subtrees, but it is still better than dropping all
      // plugin source coverage.
      this.watcher = oldWatcher;
      log.warn(
        "Plugin source watcher restart failed; keeping previous watcher active",
      );
      return;
    }

    if (oldWatcher) {
      try {
        oldWatcher.close();
      } catch (err) {
        log.warn({ err }, "Failed to close previous plugin watcher");
      }
    }

    this.rescanPlugins();
  }

  /**
   * Schedule a rebuild for every top-level entry under the plugins dir
   * that isn't already in the registry. Called after a successful
   * {@link restartWatcher} to catch new-plugin events that may have been
   * lost during the close→reopen swap.
   *
   * Existing plugins are skipped — their normal change events are
   * delivered through the freshly-attached watcher.
   */
  private rescanPlugins(): void {
    let pluginsDir: string;
    try {
      pluginsDir = getWorkspacePluginsDir();
    } catch {
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(pluginsDir);
    } catch (err) {
      log.warn({ err, pluginsDir }, "Failed to rescan plugins directory");
      return;
    }

    for (const entry of entries) {
      // Skip dotfiles / dot-directories (e.g. macOS `.DS_Store`, npm cache).
      if (entry.startsWith(".")) continue;
      // Existing plugins ride the watcher's normal event delivery. The
      // rescan is purely to catch installs whose first event was lost.
      if (getRegisteredPlugin(entry) !== undefined) continue;
      this.debouncer.schedule(`plugin:${entry}`, () => {
        void this.onChange(entry);
      });
    }
  }

  private tryWatch(): void {
    if (this.watcher) return;

    let pluginsDir: string;
    try {
      pluginsDir = getWorkspacePluginsDir();
    } catch {
      log.warn(
        "Could not resolve plugins directory; plugin source watching disabled",
      );
      return;
    }

    try {
      mkdirSync(pluginsDir, { recursive: true });
    } catch (err) {
      log.warn(
        { err, pluginsDir },
        "Could not create plugins directory; source watching disabled",
      );
      return;
    }

    try {
      this.watcher = watch(
        pluginsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const pluginName = resolvePluginNameFromRelPath(filename);
          if (!pluginName) return;

          // Per-plugin rebuild — debounced under the plugin name so bursty
          // edits collapse to a single rebuild.
          this.debouncer.schedule(`plugin:${pluginName}`, () => {
            void this.onChange(pluginName);
          });

          // Refresh the watcher to pick up any subtree that grew under us.
          // Coalesced across all plugin names; single watcher restart per
          // event burst. See restartWatcher for the rationale.
          this.restartDebouncer.schedule(WATCHER_RESTART_KEY, () => {
            this.restartWatcher();
          });
        },
      );
      log.info({ pluginsDir }, "Plugin source watcher started");
    } catch (err) {
      log.warn(
        { err },
        "Failed to watch plugins directory; source watching disabled",
      );
    }
  }
}
