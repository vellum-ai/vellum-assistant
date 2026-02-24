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
  readWhatsAppCredentials,
  type TelegramCredentials,
  type TwilioCredentials,
  type WhatsAppCredentials,
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
};

export type CredentialChangeCallback = (event: CredentialChangeEvent) => void;

export class CredentialWatcher {
  private watcher: FSWatcher | null = null;
  private watchingDirectory = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBotToken: string | undefined;
  private lastWebhookSecret: string | undefined;
  private lastTwilioAccountSid: string | undefined;
  private lastTwilioAuthToken: string | undefined;
  private lastWhatsAppPhoneNumberId: string | undefined;
  private lastWhatsAppAccessToken: string | undefined;
  private lastWhatsAppAppSecret: string | undefined;
  private lastWhatsAppWebhookVerifyToken: string | undefined;
  private callback: CredentialChangeCallback;
  private metadataPath: string;

  constructor(callback: CredentialChangeCallback) {
    this.callback = callback;
    this.metadataPath = getMetadataPath();
  }

  start(): void {
    this.pollOnce();

    this.watchingDirectory = !existsSync(this.metadataPath);
    const watchTarget = this.watchingDirectory
      ? dirname(this.metadataPath)
      : this.metadataPath;

    try {
      this.watcher = watch(watchTarget, { persistent: false }, (_event, filename) => {
        if (
          this.watchingDirectory &&
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

      if (this.watchingDirectory && existsSync(this.metadataPath)) {
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
      this.watchingDirectory = false;
      log.debug("Upgraded watcher to metadata file");
    } catch (err) {
      log.warn({ err }, "Failed to upgrade credential file watcher");
    }
  }

  private pollOnce(): void {
    const telegramCredentials = readTelegramCredentials();
    const twilioCredentials = readTwilioCredentials();
    const whatsappCredentials = readWhatsAppCredentials();

    const newBotToken = telegramCredentials?.botToken;
    const newWebhookSecret = telegramCredentials?.webhookSecret;
    const newTwilioAccountSid = twilioCredentials?.accountSid;
    const newTwilioAuthToken = twilioCredentials?.authToken;
    const newWhatsAppPhoneNumberId = whatsappCredentials?.phoneNumberId;
    const newWhatsAppAccessToken = whatsappCredentials?.accessToken;
    const newWhatsAppAppSecret = whatsappCredentials?.appSecret;
    const newWhatsAppWebhookVerifyToken = whatsappCredentials?.webhookVerifyToken;

    const telegramChanged =
      newBotToken !== this.lastBotToken ||
      newWebhookSecret !== this.lastWebhookSecret;

    const twilioChanged =
      newTwilioAccountSid !== this.lastTwilioAccountSid ||
      newTwilioAuthToken !== this.lastTwilioAuthToken;

    const whatsappChanged =
      newWhatsAppPhoneNumberId !== this.lastWhatsAppPhoneNumberId ||
      newWhatsAppAccessToken !== this.lastWhatsAppAccessToken ||
      newWhatsAppAppSecret !== this.lastWhatsAppAppSecret ||
      newWhatsAppWebhookVerifyToken !== this.lastWhatsAppWebhookVerifyToken;

    if (!telegramChanged && !twilioChanged && !whatsappChanged) {
      return;
    }

    this.lastBotToken = newBotToken;
    this.lastWebhookSecret = newWebhookSecret;
    this.lastTwilioAccountSid = newTwilioAccountSid;
    this.lastTwilioAuthToken = newTwilioAuthToken;
    this.lastWhatsAppPhoneNumberId = newWhatsAppPhoneNumberId;
    this.lastWhatsAppAccessToken = newWhatsAppAccessToken;
    this.lastWhatsAppAppSecret = newWhatsAppAppSecret;
    this.lastWhatsAppWebhookVerifyToken = newWhatsAppWebhookVerifyToken;

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
    if (whatsappChanged) {
      log.info(
        { hasCredentials: !!whatsappCredentials },
        "WhatsApp credentials changed",
      );
    }

    this.callback({
      telegramCredentials,
      telegramChanged,
      twilioCredentials,
      twilioChanged,
      whatsappCredentials,
      whatsappChanged,
    });
  }
}
