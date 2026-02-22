/**
 * Watches the assistant's credential metadata file for changes and
 * triggers a callback when Telegram or Twilio credentials are added,
 * updated, or removed.
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
  readTwilioCredentials,
  type TelegramCredentials,
  type TwilioCredentials,
} from "./credential-reader.js";

const log = getLogger("credential-watcher");

const DEBOUNCE_MS = 500;

export type CredentialChangeEvent = {
  telegramCredentials: TelegramCredentials | null;
  telegramChanged: boolean;
  twilioCredentials: TwilioCredentials | null;
  twilioChanged: boolean;
};

export type CredentialChangeCallback = (event: CredentialChangeEvent) => void;

export class CredentialWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBotToken: string | undefined;
  private lastWebhookSecret: string | undefined;
  private lastTwilioAccountSid: string | undefined;
  private lastTwilioAuthToken: string | undefined;
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
    const telegramCredentials = readTelegramCredentials();
    const twilioCredentials = readTwilioCredentials();

    const newBotToken = telegramCredentials?.botToken;
    const newWebhookSecret = telegramCredentials?.webhookSecret;
    const newTwilioAccountSid = twilioCredentials?.accountSid;
    const newTwilioAuthToken = twilioCredentials?.authToken;

    const telegramChanged =
      newBotToken !== this.lastBotToken ||
      newWebhookSecret !== this.lastWebhookSecret;

    const twilioChanged =
      newTwilioAccountSid !== this.lastTwilioAccountSid ||
      newTwilioAuthToken !== this.lastTwilioAuthToken;

    if (!telegramChanged && !twilioChanged) {
      return;
    }

    this.lastBotToken = newBotToken;
    this.lastWebhookSecret = newWebhookSecret;
    this.lastTwilioAccountSid = newTwilioAccountSid;
    this.lastTwilioAuthToken = newTwilioAuthToken;

    if (telegramChanged) {
      log.info(
        { hasCredentials: !!telegramCredentials },
        "Telegram credentials changed",
      );
    }
    if (twilioChanged) {
      log.info(
        { hasCredentials: !!twilioCredentials },
        "Twilio credentials changed",
      );
    }

    this.callback({
      telegramCredentials,
      telegramChanged,
      twilioCredentials,
      twilioChanged,
    });
  }
}
