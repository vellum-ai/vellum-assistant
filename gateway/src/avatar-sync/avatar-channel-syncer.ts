/**
 * Orchestrator that reads the assistant's avatar PNG from disk and fans out
 * sync calls to all registered channel syncers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";
import type { ChannelAvatarSyncer } from "./types.js";

const log = getLogger("avatar-sync");

function getAvatarPath(): string {
  return join(getWorkspaceDir(), "data", "avatar", "avatar-image.png");
}

export class AvatarChannelSyncer {
  private syncers = new Map<string, ChannelAvatarSyncer>();

  register(syncer: ChannelAvatarSyncer): void {
    this.syncers.set(syncer.channelName, syncer);
    log.debug({ channel: syncer.channelName }, "Registered avatar syncer");
  }

  unregister(channelName: string): void {
    if (this.syncers.delete(channelName)) {
      log.debug({ channel: channelName }, "Unregistered avatar syncer");
    }
  }

  /** Read the avatar from disk and push to all registered channels. */
  async syncAll(): Promise<void> {
    const pngBuffer = this.readAvatar();
    if (!pngBuffer) return;

    const snapshot = [...this.syncers.values()];
    const results = await Promise.allSettled(
      snapshot.map((s) => s.sync(pngBuffer)),
    );

    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        log.warn(
          { channel: snapshot[i]?.channelName, err: result.reason },
          "Avatar sync threw unexpectedly",
        );
      }
    }
  }

  /** Sync to a single channel by name (used on channel connect). */
  async syncToChannel(channelName: string): Promise<void> {
    const syncer = this.syncers.get(channelName);
    if (!syncer) return;

    const pngBuffer = this.readAvatar();
    if (!pngBuffer) return;

    await syncer.sync(pngBuffer);
  }

  private readAvatar(): Buffer | null {
    const avatarPath = getAvatarPath();
    if (!existsSync(avatarPath)) {
      log.debug("No avatar file found, skipping sync");
      return null;
    }

    try {
      return readFileSync(avatarPath);
    } catch (err) {
      log.warn({ err }, "Failed to read avatar file");
      return null;
    }
  }
}
