/**
 * Filesystem watcher for the external plugins directory.
 *
 * Watches `<workspaceDir>/plugins/` recursively using fs.watch (FSEvents on
 * macOS). When a plugin directory is created or modified, debounces per
 * top-level directory name (= the plugin name) and calls the provided
 * callback so the daemon can install + initialize the plugin without a
 * restart.
 *
 * Pairs with the in-mem registry guard in `installPluginPostBoot` so
 * already-loaded plugins are no-op'd on repeated fs events — the filesystem
 * is the source of truth, the registry is a cache.
 *
 * Mirrors `app-source-watcher.ts` (same DebouncerMap shape, same start/stop
 * lifecycle, same ensureStarted late-create hook).
 */

import { existsSync, type FSWatcher, watch } from "node:fs";

import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

const log = getLogger("plugin-source-watcher");

const PLUGIN_INSTALL_DEBOUNCE_MS = 500;

export type PluginSourceChangeCallback = (
  pluginName: string,
) => void | Promise<void>;

/**
 * Module-level ensure hook so a tool side-effect that just created the
 * plugins directory (e.g. the first `assistant plugins install`) can kick
 * the watcher into life without waiting for daemon restart.
 */
let ensureWatcherStarted: (() => void) | null = null;

export function setEnsurePluginSourceWatcher(fn: () => void): void {
  ensureWatcherStarted = fn;
}

export function ensurePluginSourceWatcher(): void {
  ensureWatcherStarted?.();
}

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
    // let the install path decide whether it's a real plugin (presence of
    // package.json, absence of register.{ts,js}).
    return relPath.length > 0 ? relPath : null;
  }
  const dirName = relPath.slice(0, slashIdx);
  return dirName.length > 0 ? dirName : null;
}

export class PluginSourceWatcher {
  private watcher: FSWatcher | null = null;
  private onChange: PluginSourceChangeCallback | null = null;
  private debouncer = new DebouncerMap({
    defaultDelayMs: PLUGIN_INSTALL_DEBOUNCE_MS,
    maxEntries: 50,
  });

  start(onChange: PluginSourceChangeCallback): void {
    this.onChange = onChange;
    this.tryWatch();
  }

  /**
   * Ensure the watcher is running. Idempotent — safe to call after a tool
   * side-effect that may have just created the plugins directory.
   */
  ensureStarted(): void {
    if (this.watcher || !this.onChange) return;
    this.tryWatch();
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

    if (!existsSync(pluginsDir)) {
      log.info(
        "Plugins directory does not exist yet; skipping source watcher",
      );
      return;
    }

    const onChange = this.onChange;
    if (!onChange) return;

    try {
      this.watcher = watch(
        pluginsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;

          const pluginName = resolvePluginNameFromRelPath(filename);
          if (!pluginName) return;

          this.debouncer.schedule(`plugin:${pluginName}`, async () => {
            try {
              await onChange(pluginName);
            } catch (err) {
              // Callback errors are swallowed at the watcher boundary so a
              // single bad plugin install never crashes the watch loop and
              // never surfaces as an unhandled rejection.
              log.warn(
                { err, plugin: pluginName },
                "plugin source watcher callback failed",
              );
            }
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

  stop(): void {
    this.debouncer.cancelAll();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
