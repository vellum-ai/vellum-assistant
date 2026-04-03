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
  getAppsDir,
  resolveAppIdByDirName,
} from "../memory/app-store.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("app-source-watcher");

const APP_REFRESH_DEBOUNCE_MS = 500;

export type AppSourceChangeCallback = (appId: string) => void;

/**
 * Resolve app ID from a relative path within the apps directory.
 * Returns null if the path is not an app source file (e.g. dist/, records/).
 */
function resolveAppIdFromRelPath(relPath: string): string | null {
  const slashIdx = relPath.indexOf("/");
  if (slashIdx === -1) return null; // file directly in apps/ (e.g. .json definition)

  const dirName = relPath.slice(0, slashIdx);
  const innerPath = relPath.slice(slashIdx + 1);

  // Skip non-source directories (include bare directory names for fs.watch events)
  if (
    innerPath === "records" || innerPath.startsWith("records/") ||
    innerPath === "dist" || innerPath.startsWith("dist/")
  ) {
    return null;
  }

  return resolveAppIdByDirName(dirName);
}

export class AppSourceWatcher {
  private watcher: FSWatcher | null = null;
  private debouncer = new DebouncerMap({
    defaultDelayMs: APP_REFRESH_DEBOUNCE_MS,
    maxEntries: 50,
  });

  start(onChange: AppSourceChangeCallback): void {
    let appsDir: string;
    try {
      appsDir = getAppsDir();
    } catch {
      log.warn("Could not resolve apps directory; app source watching disabled");
      return;
    }

    if (!existsSync(appsDir)) {
      log.info("Apps directory does not exist yet; skipping source watcher");
      return;
    }

    try {
      this.watcher = watch(appsDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;

        const appId = resolveAppIdFromRelPath(filename);
        if (!appId) return;

        this.debouncer.schedule(`app:${appId}`, () => {
          onChange(appId);
        });
      });
    } catch (err) {
      log.warn({ err }, "Failed to watch apps directory; source watching disabled");
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
