import {
  buildTwilioPhoneNumberWebhookUrls,
  resolveTwilioPublicBaseUrl,
  TWILIO_PUBLIC_BASE_URL_FIELD,
} from "@vellumai/service-contracts/twilio-ingress";
import { updatePhoneNumberWebhooks } from "@vellumai/twilio-client";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("twilio-webhook-sync");

export type TwilioWebhookSyncCaches = {
  credentials: CredentialCache;
  configFile: ConfigFileCache;
};

function resolveEffectiveTwilioBaseUrl(
  configFile: ConfigFileCache,
): string | undefined {
  if (configFile.getBoolean("ingress", "enabled", { force: true }) === false) {
    return undefined;
  }

  return resolveTwilioPublicBaseUrl({
    publicBaseUrl: configFile.getString("ingress", "publicBaseUrl"),
    [TWILIO_PUBLIC_BASE_URL_FIELD]: configFile.getString(
      "ingress",
      TWILIO_PUBLIC_BASE_URL_FIELD,
    ),
  });
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

    const urls = buildTwilioPhoneNumberWebhookUrls(baseUrl);
    await updatePhoneNumberWebhooks({
      accountSid,
      authToken,
      fetchImpl,
      phoneNumber,
      timeoutMs: 10_000,
      webhooks: urls,
    });

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
