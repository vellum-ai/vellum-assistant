/**
 * Watches the assistant's credential metadata file and the v2 store key
 * for changes, triggering a callback when channel credentials are added,
 * updated, or removed.
 *
 * Watches parent directories rather than files themselves because
 * metadata.json is rewritten via atomic rename. File-scoped fs.watch()
 * subscriptions can stay attached to the old inode after the first write,
 * causing later credential changes to be missed until restart.
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "./logger.js";
import {
  getMetadataPath,
  getRootDir,
  readCredentialMetadataStatus,
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
const UNRESOLVED_CREDENTIAL_RETRY_MS = 2_000;

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
  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryPending = false;
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

    const metadataDir = dirname(this.metadataPath);
    const protectedDir = join(getRootDir(), "protected");

    // Ensure directories exist so fs.watch() doesn't throw ENOENT
    // on a fresh hatch where no credentials have been written yet.
    mkdirSync(metadataDir, { recursive: true });
    mkdirSync(protectedDir, { recursive: true });

    // Watch the metadata directory for metadata.json changes.
    this.startWatcher(metadataDir, "metadata.json");

    // Watch the protected directory for store.key changes so that
    // creating or restoring the v2 store key triggers a credential reload.
    this.startWatcher(protectedDir, "store.key");

    // Watch keys.enc for credential writes. When credentials are re-saved
    // with the same values (e.g. in-chat credential_store re-entering
    // existing tokens), the serialized credential values won't change —
    // but the encrypted ciphertext will (new IV). Force a full reload so
    // channel listeners restart even when the plaintext values match.
    this.startWatcher(protectedDir, "keys.enc", { forceChanged: true });
  }

  private startWatcher(
    dir: string,
    targetFilename: string,
    opts?: { forceChanged?: boolean },
  ): void {
    const forceChanged = opts?.forceChanged ?? false;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== targetFilename) {
          return;
        }
        this.scheduleCheck(forceChanged);
      });
      this.watchers.push(watcher);

      log.info(
        { path: dir, file: targetFilename },
        "Watching for credential changes",
      );
    } catch (err) {
      log.warn({ err, path: dir }, "Failed to start credential file watcher");
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryPending = false;
    this.pendingPoll = false;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  /** Whether the next scheduled poll should treat all services as changed. */
  private pendingForceChanged = false;

  private scheduleCheck(forceChanged = false): void {
    if (forceChanged) this.pendingForceChanged = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const force = this.pendingForceChanged;
      this.pendingForceChanged = false;
      void this.pollOnce(force);
    }, DEBOUNCE_MS);
  }

  private scheduleRetry(unresolvedServices: string[]): void {
    if (this.retryTimer) return;

    if (!this.retryPending) {
      log.info(
        { unresolvedServices, retryMs: UNRESOLVED_CREDENTIAL_RETRY_MS },
        "Credential metadata exists but secrets are unavailable; scheduling retry",
      );
      this.retryPending = true;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pollOnce();
    }, UNRESOLVED_CREDENTIAL_RETRY_MS);
  }

  private async pollOnce(forceChanged = false): Promise<void> {
    if (this.polling) {
      // A poll is already in flight — flag that another round is needed
      // so credential updates arriving mid-poll aren't silently dropped.
      this.pendingPoll = true;
      if (forceChanged) this.pendingForceChanged = true;
      return;
    }
    this.polling = true;
    try {
      const telegramCredentials = await readTelegramCredentials();
      const twilioCredentials = await readTwilioCredentials();
      const whatsappCredentials = await readWhatsAppCredentials();
      const slackChannelCredentials = await readSlackChannelCredentials();
      const metadataStatus = readCredentialMetadataStatus();

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
        if (newVal !== oldVal || (forceChanged && newVal !== undefined)) {
          changedServices.add(name);
          if (newVal !== undefined) {
            this.lastSerialized.set(name, newVal);
          } else {
            this.lastSerialized.delete(name);
          }
        }
      }

      const unresolvedServices = [
        metadataStatus.telegram && !telegramCredentials ? "telegram" : null,
        metadataStatus.twilio && !twilioCredentials ? "twilio" : null,
        metadataStatus.whatsapp && !whatsappCredentials ? "whatsapp" : null,
        metadataStatus.slackChannel && !slackChannelCredentials
          ? "slackChannel"
          : null,
      ].filter((service): service is string => service !== null);

      if (unresolvedServices.length > 0) {
        this.scheduleRetry(unresolvedServices);
      } else if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retryPending = false;
      } else {
        this.retryPending = false;
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
        const force = this.pendingForceChanged;
        this.pendingForceChanged = false;
        void this.pollOnce(force);
      }
    }
  }
}
