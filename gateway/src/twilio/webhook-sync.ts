import {
  normalizePublicBaseUrl,
  TWILIO_PUBLIC_BASE_URL_FIELD,
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@vellumai/service-contracts/twilio-ingress";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { getLogger } from "../logger.js";
import { updatePhoneNumberWebhooks } from "./rest.js";

const log = getLogger("twilio-webhook-sync");

export type TwilioWebhookSyncCaches = {
  credentials: CredentialCache;
  configFile: ConfigFileCache;
};

function buildWebhookUrls(baseUrl: string): {
  voiceUrl: string;
  statusCallbackUrl: string;
} {
  return {
    voiceUrl: `${baseUrl}${TWILIO_VOICE_WEBHOOK_PATH}`,
    statusCallbackUrl: `${baseUrl}${TWILIO_STATUS_WEBHOOK_PATH}`,
  };
}

function resolveEffectiveTwilioBaseUrl(
  configFile: ConfigFileCache,
): string | undefined {
  if (configFile.getBoolean("ingress", "enabled", { force: true }) === false) {
    return undefined;
  }

  const twilioBaseUrl = normalizePublicBaseUrl(
    configFile.getString("ingress", TWILIO_PUBLIC_BASE_URL_FIELD),
  );
  if (twilioBaseUrl) return twilioBaseUrl;

  return normalizePublicBaseUrl(
    configFile.getString("ingress", "publicBaseUrl"),
  );
}

export async function syncConfiguredTwilioPhoneNumberWebhooks(
  caches: TwilioWebhookSyncCaches,
): Promise<void> {
  try {
    const phoneNumber = caches.configFile
      .getString("twilio", "phoneNumber")
      ?.trim();
    const accountSidFromCredentials = (
      await caches.credentials.get(credentialKey("twilio", "account_sid"))
    )?.trim();
    const accountSid =
      accountSidFromCredentials ||
      caches.configFile.getString("twilio", "accountSid")?.trim();
    const authToken = (
      await caches.credentials.get(credentialKey("twilio", "auth_token"))
    )?.trim();
    const baseUrl = resolveEffectiveTwilioBaseUrl(caches.configFile);

    if (!phoneNumber || !accountSid || !authToken || !baseUrl) {
      log.debug(
        {
          hasPhoneNumber: !!phoneNumber,
          hasAccountSid: !!accountSid,
          hasAuthToken: !!authToken,
          hasBaseUrl: !!baseUrl,
        },
        "Skipping Twilio webhook sync because configuration is incomplete",
      );
      return;
    }

    const urls = buildWebhookUrls(baseUrl);
    const updated = await updatePhoneNumberWebhooks(
      accountSid,
      authToken,
      phoneNumber,
      urls,
    );
    if (!updated) {
      log.warn(
        { phoneNumber },
        "Skipping Twilio webhook sync because configured phone number could not be updated",
      );
      return;
    }

    log.info(
      {
        phoneNumber,
        voiceUrl: urls.voiceUrl,
        statusCallbackUrl: urls.statusCallbackUrl,
      },
      "Synced Twilio phone number webhooks",
    );
  } catch (err) {
    log.warn({ err }, "Twilio webhook sync skipped after non-fatal error");
  }
}
