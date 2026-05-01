import { normalizePublicBaseUrl } from "@vellumai/service-contracts/twilio-ingress";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("twilio-webhook-sync");

const TWILIO_VOICE_PATH = "/webhooks/twilio/voice";
const TWILIO_STATUS_PATH = "/webhooks/twilio/status";

export type TwilioWebhookSyncCaches = {
  credentials: CredentialCache;
  configFile: ConfigFileCache;
};

function twilioAuthHeader(accountSid: string, authToken: string): string {
  return (
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")
  );
}

function twilioBaseUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
}

function buildWebhookUrls(baseUrl: string): {
  voiceUrl: string;
  statusCallbackUrl: string;
} {
  return {
    voiceUrl: `${baseUrl}${TWILIO_VOICE_PATH}`,
    statusCallbackUrl: `${baseUrl}${TWILIO_STATUS_PATH}`,
  };
}

function resolveEffectiveTwilioBaseUrl(
  configFile: ConfigFileCache,
): string | undefined {
  const twilioBaseUrl = normalizePublicBaseUrl(
    configFile.getString("ingress", "twilioPublicBaseUrl"),
  );
  if (twilioBaseUrl) return twilioBaseUrl;

  return normalizePublicBaseUrl(
    configFile.getString("ingress", "publicBaseUrl"),
  );
}

async function lookupIncomingPhoneNumberSid(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<string | undefined> {
  const response = await fetchImpl(
    `${twilioBaseUrl(
      accountSid,
    )}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
      phoneNumber,
    )}`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn(
      { status: response.status, detail },
      "Twilio phone number lookup failed during webhook sync",
    );
    return undefined;
  }

  const data = (await response.json().catch(() => undefined)) as
    | {
        incoming_phone_numbers?: Array<{
          sid?: string;
          phone_number?: string;
        }>;
      }
    | undefined;

  const match = data?.incoming_phone_numbers?.find(
    (number) => number.phone_number === phoneNumber && number.sid,
  );
  return match?.sid;
}

async function updateIncomingPhoneNumberWebhooks(
  accountSid: string,
  authToken: string,
  phoneNumberSid: string,
  urls: { voiceUrl: string; statusCallbackUrl: string },
): Promise<boolean> {
  const body = new URLSearchParams({
    VoiceUrl: urls.voiceUrl,
    VoiceMethod: "POST",
    StatusCallback: urls.statusCallbackUrl,
    StatusCallbackMethod: "POST",
  });

  const response = await fetchImpl(
    `${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (response.ok) return true;

  const detail = await response.text().catch(() => "");
  log.warn(
    { status: response.status, detail },
    "Twilio phone number webhook update failed",
  );
  return false;
}

export async function syncConfiguredTwilioPhoneNumberWebhooks(
  caches: TwilioWebhookSyncCaches,
): Promise<void> {
  try {
    const phoneNumber = caches.configFile
      .getString("twilio", "phoneNumber")
      ?.trim();
    const accountSid = caches.configFile
      .getString("twilio", "accountSid")
      ?.trim();
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

    const phoneNumberSid = await lookupIncomingPhoneNumberSid(
      accountSid,
      authToken,
      phoneNumber,
    );
    if (!phoneNumberSid) {
      log.warn(
        { phoneNumber },
        "Skipping Twilio webhook sync because configured phone number was not found",
      );
      return;
    }

    const urls = buildWebhookUrls(baseUrl);
    const updated = await updateIncomingPhoneNumberWebhooks(
      accountSid,
      authToken,
      phoneNumberSid,
      urls,
    );
    if (!updated) return;

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
