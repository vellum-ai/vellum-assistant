/**
 * Watches feature flag files for external modifications and invalidates /
 * refreshes the corresponding module-level caches.
 *
 * Uses the same fs.watch() + debounce pattern as CredentialWatcher and
 * ConfigFileWatcher. Watches the parent directory (not the file itself)
 * because the file is written atomically via temp-file + rename, which can
 * orphan a file-scoped watcher's inode reference.
 */

import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import {
  clearFeatureFlagStoreCache,
  getFeatureFlagStorePath,
} from "./feature-flag-store.js";
import {
  refreshRemoteFeatureFlagStoreCache,
  getRemoteFeatureFlagStorePath,
} from "./feature-flag-remote-store.js";
import { getLogger } from "./logger.js";

const log = getLogger("feature-flag-watcher");

const DEBOUNCE_MS = 500;

export class FeatureFlagWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private localFlagFilename: string;
  private remoteFlagFilename: string;
  /** Accumulates which files changed during the debounce window. */
  private pendingFilenames = new Set<string>();

  constructor() {
    this.localFlagFilename = basename(getFeatureFlagStorePath());
    this.remoteFlagFilename = basename(getRemoteFeatureFlagStorePath());
  }

  start(): void {
    const dir = dirname(getFeatureFlagStorePath());

    // Ensure the directory exists so fs.watch() doesn't throw ENOENT
    // on a fresh instance where no flags have been persisted yet.
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (
          filename &&
          filename !== this.localFlagFilename &&
          filename !== this.remoteFlagFilename
        ) {
          return;
        }
        this.scheduleInvalidation(filename ?? undefined);
      });

      // Prevent unhandled FSWatcher errors (e.g. ENXIO when the watched
      // directory is removed) from crashing the process.
      this.watcher.on("error", (err) => {
        log.warn({ err, path: dir }, "Feature flag file watcher error");
      });

      log.info({ path: dir }, "Watching for feature flag file changes");
    } catch (err) {
      log.warn({ err, path: dir }, "Failed to start feature flag file watcher");
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleInvalidation(filename?: string): void {
    if (filename) {
      this.pendingFilenames.add(filename);
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;

      const filenames = this.pendingFilenames;
      this.pendingFilenames = new Set<string>();

      if (filenames.has(this.localFlagFilename)) {
        clearFeatureFlagStoreCache();
      }
      if (filenames.has(this.remoteFlagFilename)) {
        refreshRemoteFeatureFlagStoreCache();
      }
      log.info(
        { filenames: [...filenames] },
        "Feature flag cache invalidated due to file change",
      );
    }, DEBOUNCE_MS);
  }
}
