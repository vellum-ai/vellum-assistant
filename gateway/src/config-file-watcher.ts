/**
 * Watches ~/.vellum/workspace/config.json for changes to ingress URL
 * and SMS phone number. Uses the same fs.watch() + debounce pattern
 * as CredentialWatcher.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "./logger.js";
import { getRootDir } from "./credential-reader.js";

const log = getLogger("config-file-watcher");

const DEBOUNCE_MS = 500;
const CONFIG_FILENAME = "config.json";

export type ConfigChangeEvent = {
  ingressPublicBaseUrl: string | undefined;
  ingressChanged: boolean;
  smsPhoneNumber: string | undefined;
  smsPhoneNumberChanged: boolean;
  assistantPhoneNumbers: Record<string, string> | undefined;
  assistantPhoneNumbersChanged: boolean;
  assistantEmail: string | undefined;
  assistantEmailChanged: boolean;
  twilioAccountSid: string | undefined;
  twilioAccountSidChanged: boolean;
};

export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

function getConfigPath(): string {
  return join(getRootDir(), "workspace", CONFIG_FILENAME);
}

function readConfigFile(path: string): {
  ingressPublicBaseUrl?: string;
  smsPhoneNumber?: string;
  assistantPhoneNumbers?: Record<string, string>;
  assistantEmail?: string;
  twilioAccountSid?: string;
} {
  try {
    if (!existsSync(path)) return {};

    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};

    const ingressPublicBaseUrl =
      data.ingress && typeof data.ingress.publicBaseUrl === "string"
        ? data.ingress.publicBaseUrl || undefined
        : undefined;

    const smsPhoneNumber =
      data.sms && typeof data.sms.phoneNumber === "string"
        ? data.sms.phoneNumber || undefined
        : undefined;

    let assistantPhoneNumbers: Record<string, string> | undefined;
    if (
      data.sms &&
      typeof data.sms.assistantPhoneNumbers === "object" &&
      data.sms.assistantPhoneNumbers !== null &&
      !Array.isArray(data.sms.assistantPhoneNumbers)
    ) {
      assistantPhoneNumbers = data.sms.assistantPhoneNumbers as Record<
        string,
        string
      >;
    }

    const assistantEmail =
      data.email && typeof data.email.address === "string"
        ? data.email.address || undefined
        : undefined;

    const twilioAccountSid =
      data.twilio && typeof data.twilio.accountSid === "string"
        ? data.twilio.accountSid || undefined
        : undefined;

    return {
      ingressPublicBaseUrl,
      smsPhoneNumber,
      assistantPhoneNumbers,
      assistantEmail,
      twilioAccountSid,
    };
  } catch (err) {
    log.debug({ err }, "Failed to read config file");
    return {};
  }
}

export class ConfigFileWatcher {
  private watcher: FSWatcher | null = null;
  private watchingDirectory = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastIngressPublicBaseUrl: string | undefined;
  private lastSmsPhoneNumber: string | undefined;
  private lastAssistantPhoneNumbers: Record<string, string> | undefined;
  private lastAssistantEmail: string | undefined;
  private lastTwilioAccountSid: string | undefined;
  private callback: ConfigChangeCallback;
  private configPath: string;

  constructor(callback: ConfigChangeCallback) {
    this.callback = callback;
    this.configPath = getConfigPath();
  }

  start(): void {
    this.pollOnce();

    this.watchingDirectory = !existsSync(this.configPath);
    const watchTarget = this.watchingDirectory
      ? dirname(this.configPath)
      : this.configPath;

    try {
      this.watcher = watch(
        watchTarget,
        { persistent: false },
        (_event, filename) => {
          if (this.watchingDirectory && filename !== CONFIG_FILENAME) {
            return;
          }
          this.scheduleCheck();
        },
      );

      log.info({ path: watchTarget }, "Watching for config file changes");
    } catch (err) {
      log.warn(
        { err, path: watchTarget },
        "Failed to start config file watcher",
      );
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

      if (this.watchingDirectory && existsSync(this.configPath)) {
        this.upgradeWatcher();
      }
    }, DEBOUNCE_MS);
  }

  private upgradeWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (!existsSync(this.configPath)) return;

    try {
      this.watcher = watch(this.configPath, { persistent: false }, () => {
        this.scheduleCheck();
      });
      this.watchingDirectory = false;
      log.debug("Upgraded watcher to config file");
    } catch (err) {
      log.warn({ err }, "Failed to upgrade config file watcher");
    }
  }

  private pollOnce(): void {
    const {
      ingressPublicBaseUrl,
      smsPhoneNumber,
      assistantPhoneNumbers,
      assistantEmail,
      twilioAccountSid,
    } = readConfigFile(this.configPath);

    const ingressChanged =
      ingressPublicBaseUrl !== this.lastIngressPublicBaseUrl;
    const smsPhoneNumberChanged = smsPhoneNumber !== this.lastSmsPhoneNumber;
    // Shallow JSON comparison is sufficient for the Record<string, string> mapping
    const assistantPhoneNumbersChanged =
      JSON.stringify(assistantPhoneNumbers) !==
      JSON.stringify(this.lastAssistantPhoneNumbers);
    const assistantEmailChanged = assistantEmail !== this.lastAssistantEmail;
    const twilioAccountSidChanged =
      twilioAccountSid !== this.lastTwilioAccountSid;

    if (
      !ingressChanged &&
      !smsPhoneNumberChanged &&
      !assistantPhoneNumbersChanged &&
      !assistantEmailChanged &&
      !twilioAccountSidChanged
    ) {
      return;
    }

    this.lastIngressPublicBaseUrl = ingressPublicBaseUrl;
    this.lastSmsPhoneNumber = smsPhoneNumber;
    this.lastAssistantPhoneNumbers = assistantPhoneNumbers;
    this.lastAssistantEmail = assistantEmail;
    this.lastTwilioAccountSid = twilioAccountSid;

    if (ingressChanged) {
      log.info(
        { ingressPublicBaseUrl },
        "Ingress URL updated from config file",
      );
    }
    if (smsPhoneNumberChanged) {
      log.info({ smsPhoneNumber }, "SMS phone number updated");
    }
    if (assistantPhoneNumbersChanged) {
      log.info({ assistantPhoneNumbers }, "Assistant phone numbers updated");
    }
    if (assistantEmailChanged) {
      log.info({ assistantEmail }, "Assistant email updated from config file");
    }
    if (twilioAccountSidChanged) {
      log.info(
        { twilioAccountSid },
        "Twilio account SID updated from config file",
      );
    }

    this.callback({
      ingressPublicBaseUrl,
      ingressChanged,
      smsPhoneNumber,
      smsPhoneNumberChanged,
      assistantPhoneNumbers,
      assistantPhoneNumbersChanged,
      assistantEmail,
      assistantEmailChanged,
      twilioAccountSid,
      twilioAccountSidChanged,
    });
  }
}
