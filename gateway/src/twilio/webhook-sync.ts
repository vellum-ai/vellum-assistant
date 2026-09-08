import {
  buildTwilioPhoneNumberWebhookUrls,
  resolveTwilioPublicBaseUrl,
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@vellumai/service-contracts/twilio-ingress";
import { updatePhoneNumberWebhooks } from "@vellumai/twilio-client";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { registerWebhookIngressRoute } from "../db/webhook-ingress-route-store.js";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("twilio-webhook-sync");

const TWILIO_WEBHOOK_CLAIMS: readonly { path: string; type: string }[] = [
  { path: TWILIO_VOICE_WEBHOOK_PATH, type: "twilio_voice" },
  { path: TWILIO_STATUS_WEBHOOK_PATH, type: "twilio_status" },
];

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
  });
}

/**
 * Record the voice and status paths in the webhook ingress registry.
 *
 * These two are reachable already: the whole `/webhooks/twilio/` subtree is a
 * static allowance, because the media-stream path carries call state that an
 * exact-match row cannot express. Claiming the two paths that are exact makes
 * the registry describe them, which is what retiring the static prefix down to
 * the media-stream subtree needs. Nothing depends on the rows yet, so a claim
 * that fails is logged and the sync continues.
 */
function claimTwilioWebhookIngressRoutes(phoneNumber: string): void {
  if (!isFeatureFlagEnabled("velay-webhooks")) {
    return;
  }
  for (const claim of TWILIO_WEBHOOK_CLAIMS) {
    try {
      registerWebhookIngressRoute({ ...claim, source: phoneNumber });
    } catch (err) {
      log.warn(
        { err, path: claim.path },
        "Could not claim a Twilio webhook path in the ingress registry",
      );
    }
  }
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

    claimTwilioWebhookIngressRoutes(phoneNumber);

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
