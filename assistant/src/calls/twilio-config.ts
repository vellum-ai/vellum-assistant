import { getTwilioPhoneNumberEnv, getTwilioWssBaseUrl } from "../config/env.js";
import { loadConfig } from "../config/loader.js";
import {
  getPublicBaseUrl,
  getTwilioRelayUrl,
} from "../inbound/public-ingress-urls.js";
import { getSecureKey } from "../security/secure-keys.js";
import { ConfigError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("twilio-config");

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  webhookBaseUrl: string;
  wssBaseUrl: string;
}

function resolveTwilioPhoneNumber(
  config: ReturnType<typeof loadConfig>,
  assistantId?: string,
): string {
  if (assistantId) {
    const scoped = (
      config.sms?.assistantPhoneNumbers as Record<string, string> | undefined
    )?.[assistantId];
    if (scoped) return scoped;
  }
  return (
    getTwilioPhoneNumberEnv() ||
    config.sms?.phoneNumber ||
    getSecureKey("credential:twilio:phone_number") ||
    ""
  );
}

export function getTwilioConfig(assistantId?: string): TwilioConfig {
  const accountSid = getSecureKey("credential:twilio:account_sid");
  const authToken = getSecureKey("credential:twilio:auth_token");
  const config = loadConfig();
  const phoneNumber = resolveTwilioPhoneNumber(config, assistantId);
  const webhookBaseUrl = getPublicBaseUrl(config);

  // Always use the centralized relay URL derived from the public ingress base URL.
  // TWILIO_WSS_BASE_URL is ignored.
  let wssBaseUrl: string;
  if (getTwilioWssBaseUrl()) {
    log.warn(
      "TWILIO_WSS_BASE_URL env var is deprecated. Relay URL is derived from ingress.publicBaseUrl.",
    );
  }
  try {
    wssBaseUrl = getTwilioRelayUrl(config);
  } catch {
    wssBaseUrl = "";
  }

  if (!accountSid || !authToken) {
    throw new ConfigError(
      "Twilio credentials not configured. Set credential:twilio:account_sid and credential:twilio:auth_token via the credential_store tool.",
    );
  }
  if (!phoneNumber) {
    throw new ConfigError("Twilio phone number not configured.");
  }

  log.debug("Twilio config loaded successfully");

  return { accountSid, authToken, phoneNumber, webhookBaseUrl, wssBaseUrl };
}
