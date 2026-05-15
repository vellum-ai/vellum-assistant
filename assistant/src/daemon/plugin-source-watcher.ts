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
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";

import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { reregisterExternalPlugin } from "./external-plugins-bootstrap.js";

const log = getLogger("plugin-source-watcher");

const PLUGIN_SOURCE_DEBOUNCE_MS = 500;

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
    return relPath.length > 0 ? relPath : null;
  }
  const dirName = relPath.slice(0, slashIdx);
  return dirName.length > 0 ? dirName : null;
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
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private onChange(pluginName: string): Promise<void> {
    return reregisterExternalPlugin(pluginName);
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
          this.debouncer.schedule(`plugin:${pluginName}`, () => {
            void this.onChange(pluginName);
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
