/**
 * Watches the avatar directory for changes and triggers sync to all
 * registered channels. Follows the same fs.watch + debounce pattern as
 * ConfigFileWatcher.
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";
import type { AvatarChannelSyncer } from "./avatar-channel-syncer.js";

const log = getLogger("avatar-sync-watcher");

const AVATAR_FILENAME = "avatar-image.png";

/**
 * Debounce interval (ms). Longer than the config watcher (500ms) because
 * avatar rendering writes character-traits.json first, then renders and
 * writes the PNG. A 2s window avoids syncing a partially-written file.
 */
const DEBOUNCE_MS = 2_000;

function getAvatarDir(): string {
  return join(getWorkspaceDir(), "data", "avatar");
}

export class AvatarSyncWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly syncer: AvatarChannelSyncer) {}

  start(): void {
    const avatarDir = getAvatarDir();

    // Ensure the directory exists so fs.watch doesn't throw ENOENT
    // on a fresh install where no avatar has been set yet.
    mkdirSync(avatarDir, { recursive: true });

    try {
      this.watcher = watch(
        avatarDir,
        { persistent: false },
        (_event, filename) => {
          if (filename !== AVATAR_FILENAME) return;
          this.scheduleSync();
        },
      );

      log.info({ path: avatarDir }, "Watching for avatar changes");
    } catch (err) {
      log.warn({ err, path: avatarDir }, "Failed to start avatar sync watcher");
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

  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncer.syncAll().catch((err) => {
        log.warn({ err }, "Avatar sync failed after file change");
      });
    }, DEBOUNCE_MS);
  }
}
