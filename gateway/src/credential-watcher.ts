/**
 * Watches the assistant's credential metadata file for changes and
 * triggers a callback when Telegram or Twilio credentials are added,
 * updated, or removed.
 *
 * Watches the parent directory rather than the file itself because
 * metadata.json is rewritten via atomic rename. File-scoped fs.watch()
 * subscriptions can stay attached to the old inode after the first write,
 * causing later credential changes to be missed until restart.
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "./logger.js";
import {
  getMetadataPath,
  readTelegramCredentials,
  readTwilioCredentials,
  readWhatsAppCredentials,
  readSlackChannelCredentials,
  type TelegramCredentials,
  type TwilioCredentials,
  type WhatsAppCredentials,
  type SlackChannelCredentials,
} from "./credential-reader.js";

const log = getLogger("credential-watcher");

const DEBOUNCE_MS = 500;

export type CredentialChangeEvent = {
  telegramCredentials: TelegramCredentials | null;
  telegramChanged: boolean;
  twilioCredentials: TwilioCredentials | null;
  twilioChanged: boolean;
  whatsappCredentials: WhatsAppCredentials | null;
  whatsappChanged: boolean;
  slackChannelCredentials: SlackChannelCredentials | null;
  slackChannelChanged: boolean;
};

export type CredentialChangeCallback = (event: CredentialChangeEvent) => void;

export class CredentialWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSerialized: Map<string, string> = new Map();
  private polling = false;
  private pendingPoll = false;
  private callback: CredentialChangeCallback;
  private metadataPath: string;

  constructor(callback: CredentialChangeCallback) {
    this.callback = callback;
    this.metadataPath = getMetadataPath();
  }

  async start(): Promise<void> {
    await this.pollOnce();

    const watchTarget = dirname(this.metadataPath);

    // Ensure the directory exists so fs.watch() doesn't throw ENOENT
    // on a fresh hatch where no credentials have been written yet.
    mkdirSync(watchTarget, { recursive: true });

    try {
      this.watcher = watch(
        watchTarget,
        { persistent: false },
        (_event, filename) => {
          if (filename && filename !== "metadata.json") {
            return;
          }
          this.scheduleCheck();
        },
      );

      log.info({ path: watchTarget }, "Watching for credential changes");
    } catch (err) {
      log.warn(
        { err, path: watchTarget },
        "Failed to start credential file watcher",
      );
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPoll = false;
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
      void this.pollOnce();
    }, DEBOUNCE_MS);
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) {
      // A poll is already in flight — flag that another round is needed
      // so credential updates arriving mid-poll aren't silently dropped.
      this.pendingPoll = true;
      return;
    }
    this.polling = true;
    try {
      const telegramCredentials = await readTelegramCredentials();
      const twilioCredentials = await readTwilioCredentials();
      const whatsappCredentials = await readWhatsAppCredentials();
      const slackChannelCredentials = await readSlackChannelCredentials();

      const services = {
        telegram: { creds: telegramCredentials, key: "telegram" },
        twilio: { creds: twilioCredentials, key: "twilio" },
        whatsapp: { creds: whatsappCredentials, key: "whatsapp" },
        slackChannel: { creds: slackChannelCredentials, key: "slackChannel" },
      };

      const changedServices = new Set<string>();
      for (const [name, { creds }] of Object.entries(services)) {
        const newVal = creds ? JSON.stringify(creds) : undefined;
        const oldVal = this.lastSerialized.get(name);
        if (newVal !== oldVal) {
          changedServices.add(name);
          if (newVal !== undefined) {
            this.lastSerialized.set(name, newVal);
          } else {
            this.lastSerialized.delete(name);
          }
        }
      }

      if (changedServices.size === 0) return;

      this.callback({
        telegramCredentials,
        telegramChanged: changedServices.has("telegram"),
        twilioCredentials,
        twilioChanged: changedServices.has("twilio"),
        whatsappCredentials,
        whatsappChanged: changedServices.has("whatsapp"),
        slackChannelCredentials,
        slackChannelChanged: changedServices.has("slackChannel"),
      });
    } finally {
      this.polling = false;
      if (this.pendingPoll) {
        this.pendingPoll = false;
        void this.pollOnce();
      }
    }
  }
}
