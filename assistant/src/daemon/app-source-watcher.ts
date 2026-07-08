/**
 * Filesystem watcher for app source directories.
 *
 * Watches the apps root directory recursively using fs.watch (FSEvents on
 * macOS). When a source file changes, debounces per app ID and calls the
 * provided callback so the server can recompile + refresh surfaces.
 *
 * This catches ALL modification sources (file_edit, file_write, bash, etc.)
 * without relying on individual tool hooks.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";

import {
  getApp,
  getAppDirPath,
  getAppsDir,
  isMultifileApp,
  resolveAppIdByDirName,
} from "../apps/app-store.js";
import { compileApp } from "../bundler/app-compiler.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { publishAppsChanged } from "../runtime/sync/resource-sync-events.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import { DebouncerMap } from "../util/debounce.js";
import { attachFsWatcherErrorHandler } from "../util/fs-watcher-error.js";
import { getLogger } from "../util/logger.js";
import { allConversations } from "./conversation-registry.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";

const log = getLogger("app-source-watcher");

const APP_REFRESH_DEBOUNCE_MS = 500;

export type AppSourceChangeCallback = (appId: string) => void;

/** Process-level singleton; created by {@link startAppSourceWatcher}. */
let instance: AppSourceWatcher | null = null;

/**
 * Ensure the watcher is running. Called by tool-side-effects after the apps
 * directory may have been created (e.g. on first app_create), since the
 * watcher is skipped at startup when the directory doesn't exist yet.
 */
export function ensureAppSourceWatcher(): void {
  instance?.ensureStarted();
}

/**
 * Resolve app ID from a relative path within the apps directory.
 * Returns null if the path is not an app source file (e.g. dist/, records/).
 */
function resolveAppIdFromRelPath(relPath: string): string | null {
  const slashIdx = relPath.indexOf("/");
  if (slashIdx === -1) return null; // file directly in apps/ (e.g. .json definition)

  const dirName = relPath.slice(0, slashIdx);
  const innerPath = relPath.slice(slashIdx + 1);

  // Skip a git repo at the root of the apps directory. Older installs may
  // still carry a legacy .git there; its objects/index/refs churn constantly,
  // and each event would otherwise hit resolveAppIdByDirName -> existsSync,
  // which is needless work on a path that can never be an app.
  if (dirName === ".git") {
    return null;
  }

  // Skip non-source directories (include bare directory names for fs.watch events)
  if (
    innerPath === "records" ||
    innerPath.startsWith("records/") ||
    innerPath === "dist" ||
    innerPath.startsWith("dist/")
  ) {
    return null;
  }

  return resolveAppIdByDirName(dirName);
}

export class AppSourceWatcher {
  private watcher: FSWatcher | null = null;
  private onChange: AppSourceChangeCallback | null = null;
  private debouncer = new DebouncerMap({
    defaultDelayMs: APP_REFRESH_DEBOUNCE_MS,
    maxEntries: 50,
  });

  start(onChange: AppSourceChangeCallback): void {
    this.onChange = onChange;
    this.tryWatch();
  }

  /**
   * Ensure the watcher is running. Call after app creation so the watcher
   * starts if the apps directory was created after daemon startup.
   */
  ensureStarted(): void {
    if (this.watcher || !this.onChange) return;
    this.tryWatch();
  }

  private tryWatch(): void {
    if (this.watcher) return;

    let appsDir: string;
    try {
      appsDir = getAppsDir();
    } catch {
      log.warn(
        "Could not resolve apps directory; app source watching disabled",
      );
      return;
    }

    if (!existsSync(appsDir)) {
      log.info("Apps directory does not exist yet; skipping source watcher");
      return;
    }

    const onChange = this.onChange;
    if (!onChange) return;

    try {
      this.watcher = watch(
        appsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;

          const appId = resolveAppIdFromRelPath(filename);
          if (!appId) return;

          this.debouncer.schedule(`app:${appId}`, () => {
            onChange(appId);
          });
        },
      );
      // Recursive watches over app trees (incl. node_modules) can exhaust the
      // inotify watch limit and emit ENOSPC asynchronously. Without an 'error'
      // listener that unhandled emitter error crashes the daemon.
      attachFsWatcherErrorHandler(this.watcher, log, appsDir);
      log.info("App source watcher started");
    } catch (err) {
      log.warn(
        { err },
        "Failed to watch apps directory; source watching disabled",
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

/**
 * Handle a detected app source file change. Recompiles multifile apps and
 * refreshes surfaces across ALL conversations.
 */
function handleAppSourceChange(appId: string): void {
  const app = getApp(appId);
  if (!app) return;

  const doRefresh = () => {
    for (const conversation of allConversations()) {
      refreshSurfacesForApp(conversation, appId, { fileChange: true });
    }
    broadcastMessage({ type: "app_files_changed", appId });
    publishAppsChanged();
    void updatePublishedAppDeployment(appId);
  };

  if (isMultifileApp(app)) {
    const appDir = getAppDirPath(appId);
    void compileApp(appDir)
      .then((result) => {
        if (!result.ok) {
          log.warn(
            { appId, errors: result.errors },
            "Recompile failed on app source change",
          );
        }
        doRefresh();
      })
      .catch((err) => {
        log.warn({ appId, err }, "Recompile threw on app source change");
        doRefresh();
      });
    return;
  }

  doRefresh();
}

/** Start watching app source directories for the life of the daemon. */
export function startAppSourceWatcher(): void {
  instance = new AppSourceWatcher();
  instance.start(handleAppSourceChange);
}

/** Stop the app source watcher during daemon shutdown. */
export function stopAppSourceWatcher(): void {
  instance?.stop();
  instance = null;
}
