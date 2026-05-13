/**
 * Filesystem watcher for the workspace `plugins/` directory.
 *
 * Watches `<workspaceDir>/plugins/` recursively. When a file changes,
 * debounces per top-level plugin directory and invokes
 * {@link installPluginPostBoot} — which is idempotent on already-registered
 * plugins, so `node_modules` churn during install coalesces into a single
 * load attempt after the dust settles.
 *
 * This lets `assistant plugins install <name>` stay a pure filesystem
 * write: the daemon picks the new plugin up on its own without any
 * CLI ↔ daemon IPC plumbing. The filesystem is the source of truth; the
 * in-memory registry is a cache of what's on disk.
 *
 * Lifecycle:
 *   - {@link bootstrapPlugins} starts the watcher after the boot-time
 *     plugin pass completes. Only starts when the `external-plugins`
 *     feature flag is enabled — same gate as `installPluginPostBoot`.
 *   - The "plugins" shutdown hook stops the watcher before tearing down
 *     active plugins so we don't race a final change event against the
 *     drain.
 *
 * What this watcher does NOT do (deliberate scope limits):
 *   - **Unregister** plugins on directory deletion. Unregister is a
 *     separate concern handled by a future PR; today the watcher only
 *     registers new plugins.
 *   - **Hot-reload** existing plugins. A file edit inside an
 *     already-loaded plugin keeps the running version. Reloading would
 *     need a teardown → rebuild → re-init sequence; deferred.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";

import { isExternalPluginsEnabled } from "../plugins/feature-gate.js";
import { getRegisteredPlugin } from "../plugins/registry.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import {
  type DaemonContext,
  installPluginPostBoot,
} from "./external-plugins-bootstrap.js";

const log = getLogger("plugin-source-watcher");

/**
 * Debounce window between the last filesystem event for a plugin
 * directory and the install attempt. 500ms matches the AppSourceWatcher
 * tuning — long enough that `bun install` finishing inside the plugin
 * dir doesn't trigger a half-loaded build attempt, short enough that the
 * user sees their plugin become available "instantly".
 */
const PLUGIN_RELOAD_DEBOUNCE_MS = 500;

/**
 * Extract the top-level plugin directory name from a path relative to
 * `<workspaceDir>/plugins/`. Returns `null` for events that don't belong
 * to any specific plugin (loose files directly under `plugins/`,
 * empty filename).
 *
 * fs.watch on macOS (FSEvents) delivers paths with `/` separators
 * regardless of OS; on Linux inotify uses the platform separator. Bun
 * normalises to `/` in its `fs.watch` shim, so this function only has
 * to handle the forward-slash case.
 */
export function resolvePluginNameFromRelPath(
  relPath: string,
): string | null {
  if (!relPath) return null;
  const slashIdx = relPath.indexOf("/");
  if (slashIdx === -1) {
    // A loose file directly under `plugins/` (e.g. a README) — no
    // plugin owns it.
    return null;
  }
  const dirName = relPath.slice(0, slashIdx);
  if (!dirName) return null;
  return dirName;
}

/**
 * Filesystem watcher singleton. The daemon has at most one of these:
 * `bootstrapPlugins` calls {@link startPluginSourceWatcher} on startup
 * and the "plugins" shutdown hook calls {@link stopPluginSourceWatcher}
 * on teardown. The lifecycle latch matches the existing
 * `shutdownHookInstalled` pattern in `external-plugins-bootstrap.ts`.
 */
class PluginSourceWatcher {
  private watcher: FSWatcher | null = null;
  private ctx: DaemonContext | null = null;
  private debouncer = new DebouncerMap({
    defaultDelayMs: PLUGIN_RELOAD_DEBOUNCE_MS,
    maxEntries: 100,
  });

  start(ctx: DaemonContext): void {
    if (this.watcher) return;

    // Same feature gate as `installPluginPostBoot`. Keeps the watcher's
    // surface area aligned with the rest of the external-plugins system —
    // when the flag is off, the daemon doesn't watch and the boot-time
    // pass is also skipped, so nothing about external plugins is active.
    if (!isExternalPluginsEnabled(ctx.config)) {
      log.debug(
        "external-plugins feature flag disabled; watcher not started",
      );
      return;
    }

    const pluginsDir = getWorkspacePluginsDir();
    if (!existsSync(pluginsDir)) {
      // The CLI installer creates this dir lazily on the first install.
      // We could create it eagerly here, but that pollutes the workspace
      // on daemons that never use plugins. Defer: when the user installs
      // a plugin, the install path mkdir's `plugins/`, and a follow-up
      // call to {@link ensurePluginSourceWatcher} (wired into the
      // installer's tool side-effects) restarts the watcher. For the
      // CLI flow specifically, the user starts a new daemon afterwards
      // anyway, so the lazy startup path is the common case.
      log.info(
        { pluginsDir },
        "Plugins directory does not exist yet; watcher not started",
      );
      return;
    }

    this.ctx = ctx;

    try {
      this.watcher = watch(
        pluginsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const pluginName = resolvePluginNameFromRelPath(filename);
          if (!pluginName) return;

          // Cheap skip: don't even debounce events for an already-loaded
          // plugin. Saves wakeups during normal use (e.g. a plugin
          // touching its own working files inside its install dir).
          if (getRegisteredPlugin(pluginName)) return;

          this.debouncer.schedule(`plugin:${pluginName}`, () => {
            void this.tryInstall(pluginName);
          });
        },
      );
      log.info({ pluginsDir }, "Plugin source watcher started");
    } catch (err) {
      // fs.watch can throw on some platforms (e.g. ENOSPC on Linux when
      // inotify watch limits are exhausted). Fall back to "no live load"
      // — the daemon still works, the user just has to restart to pick
      // up new plugins.
      log.warn(
        { err, pluginsDir },
        "Failed to watch plugins directory; live-load disabled",
      );
    }
  }

  /**
   * Awaitable variant for tests. The debouncer flushes in {@link stop},
   * but tests that want to assert "plugin loaded after waiting" need to
   * advance past the debounce window without stopping the watcher.
   */
  private async tryInstall(pluginName: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    // Re-check after the debounce window — the registry state may have
    // shifted while we waited (e.g. a parallel install).
    if (getRegisteredPlugin(pluginName)) return;

    let result;
    try {
      result = await installPluginPostBoot(pluginName, ctx);
    } catch (err) {
      // installPluginPostBoot is designed not to throw, but defense in
      // depth: a watcher callback that throws would otherwise crash the
      // process via Node's unhandledRejection.
      log.error(
        { err, plugin: pluginName },
        "Unexpected error during plugin reload",
      );
      return;
    }

    switch (result.status) {
      case "loaded":
        log.info({ plugin: pluginName }, "Plugin loaded from disk");
        return;
      case "already-registered":
        // Race: parallel debounce window beat us, or the boot pass
        // already registered this plugin before the watcher fired.
        return;
      case "feature-disabled":
      case "not-bootstrapped":
        // Daemon-state failures that shouldn't happen mid-run — log so
        // a misconfiguration surfaces.
        log.warn(
          { plugin: pluginName, status: result.status },
          "Plugin reload skipped due to runtime state",
        );
        return;
      case "build-failed":
        // Most commonly: filesystem event fired while files were still
        // being written. The debouncer absorbs the common case; a
        // persistent build-failed status means the install really is
        // broken on disk. Log at warn — a stale half-install is the
        // user's problem to clean up.
        log.warn(
          { plugin: pluginName, error: result.error },
          "Plugin reload failed: build failed",
        );
        return;
      case "init-failed":
        log.warn(
          { plugin: pluginName, error: result.error },
          "Plugin reload failed: init() threw",
        );
        return;
      case "not-found":
        log.debug(
          { plugin: pluginName },
          "Plugin reload skipped: directory disappeared (likely an uninstall)",
        );
        return;
      case "gated":
        log.info(
          { plugin: pluginName },
          "Plugin reload skipped: gated by manifest.requiresFlag",
        );
        return;
    }
  }

  stop(): void {
    this.debouncer.cancelAll();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.ctx = null;
  }

  /**
   * Test hook — reset internal state so a fresh `start()` after a
   * previous teardown gets a clean watcher. Production code uses
   * `start()` + `stop()` which already cycle the state correctly; this
   * is purely for test cleanliness.
   */
  resetForTests(): void {
    this.stop();
  }
}

const singleton = new PluginSourceWatcher();

/**
 * Start the watcher. Idempotent — repeated calls are no-ops. Wired into
 * {@link bootstrapPlugins} so the watcher's lifetime exactly matches
 * the rest of the external-plugins subsystem.
 */
export function startPluginSourceWatcher(ctx: DaemonContext): void {
  singleton.start(ctx);
}

/**
 * Stop the watcher. Idempotent — repeated calls are no-ops. Wired into
 * the "plugins" shutdown hook so a final filesystem event mid-teardown
 * can't race a partially-drained registry.
 */
export function stopPluginSourceWatcher(): void {
  singleton.stop();
}

/**
 * Test hook — used by `__tests__/plugin-source-watcher.test.ts` to
 * reset the singleton between cases. Not exported from the daemon
 * barrel; consumers outside tests should use start/stop.
 */
export function _resetPluginSourceWatcherForTests(): void {
  singleton.resetForTests();
}
