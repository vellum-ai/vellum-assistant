/**
 * Watches the assistant's credential metadata file for changes and
 * triggers a callback when Telegram credentials are added, updated,
 * or removed.
 *
 * Uses fs.watch() on the metadata file with debouncing to avoid
 * rapid re-reads from atomic rename writes.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "./logger.js";
import {
  getMetadataPath,
  readTelegramCredentials,
  type TelegramCredentials,
} from "./credential-reader.js";

const log = getLogger("credential-watcher");

const DEBOUNCE_MS = 500;

export type CredentialChangeCallback = (
  credentials: TelegramCredentials | null,
) => void;

export class CredentialWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBotToken: string | undefined;
  private lastWebhookSecret: string | undefined;
  private callback: CredentialChangeCallback;
  private metadataPath: string;

  constructor(callback: CredentialChangeCallback) {
    this.callback = callback;
    this.metadataPath = getMetadataPath();
  }

  start(): void {
    this.pollOnce();

    const watchTarget = existsSync(this.metadataPath)
      ? this.metadataPath
      : dirname(this.metadataPath);

    try {
      this.watcher = watch(watchTarget, { persistent: false }, (_event, filename) => {
        if (
          watchTarget !== this.metadataPath &&
          filename !== "metadata.json"
        ) {
          return;
        }
        this.scheduleCheck();
      });

      log.info({ path: watchTarget }, "Watching for credential changes");
    } catch (err) {
      log.warn({ err, path: watchTarget }, "Failed to start credential file watcher");
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

  private scheduleCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pollOnce();

      if (
        !this.watcher ||
        (existsSync(this.metadataPath) &&
          this.watcher.ref === undefined)
      ) {
        this.upgradeWatcher();
      }
    }, DEBOUNCE_MS);
  }

  private upgradeWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (!existsSync(this.metadataPath)) return;

    try {
      this.watcher = watch(
        this.metadataPath,
        { persistent: false },
        () => {
          this.scheduleCheck();
        },
      );
      log.debug("Upgraded watcher to metadata file");
    } catch (err) {
      log.warn({ err }, "Failed to upgrade credential file watcher");
    }
  }

  private pollOnce(): void {
    const credentials = readTelegramCredentials();

    const newBotToken = credentials?.botToken;
    const newWebhookSecret = credentials?.webhookSecret;

    if (
      newBotToken === this.lastBotToken &&
      newWebhookSecret === this.lastWebhookSecret
    ) {
      return;
    }

    this.lastBotToken = newBotToken;
    this.lastWebhookSecret = newWebhookSecret;

    log.info(
      { hasCredentials: !!credentials },
      "Telegram credentials changed",
    );

    this.callback(credentials);
  }
}
