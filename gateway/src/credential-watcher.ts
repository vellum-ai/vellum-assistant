/**
 * Watches the assistant's credential metadata file for changes and
 * triggers a callback when Telegram or Twilio credentials are added,
 * updated, or removed.
 *
 * Always watches the parent **directory** rather than the metadata file
 * itself, because the metadata store uses atomic rename writes
 * (write-to-tmp + renameSync). Watching a file by path on macOS uses
 * kqueue which is inode-based — once the file is replaced via rename
 * the watcher silently stops receiving events for the new file.
 * Directory watches survive atomic renames because the directory inode
 * doesn't change.
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
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
  private metadataFilename: string;
  private metadataDir: string;

  constructor(callback: CredentialChangeCallback) {
    this.callback = callback;
    this.metadataPath = getMetadataPath();
    this.metadataFilename = basename(this.metadataPath);
    this.metadataDir = dirname(this.metadataPath);
  }

  async start(): Promise<void> {
    await this.pollOnce();

    // Always watch the directory — file watches break on atomic
    // rename writes (kqueue tracks inodes, not paths).
    mkdirSync(this.metadataDir, { recursive: true });

    try {
      this.watcher = watch(
        this.metadataDir,
        { persistent: false },
        (_event, filename) => {
          // Filter to only metadata.json changes (ignore tmp files, etc.).
          // Accept null filenames — some platforms don't report the name
          // for rename events; treat them as potential metadata changes.
          if (filename != null && filename !== this.metadataFilename) {
            return;
          }
          this.scheduleCheck();
        },
      );

      log.info(
        { path: this.metadataDir },
        "Watching directory for credential changes",
      );
    } catch (err) {
      log.warn(
        { err, path: this.metadataDir },
        "Failed to start credential directory watcher",
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
