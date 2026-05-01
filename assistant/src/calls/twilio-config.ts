import { loadConfig } from "../config/loader.js";
import {
  getPublicBaseUrl,
  getTwilioRelayUrl,
} from "../inbound/public-ingress-urls.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
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

/**
 * Resolve the Twilio phone number using a unified fallback chain so that
 * all callers (calls, readiness checks, invite transports)
 * agree on the same number.
 *
 * Resolution order:
 *   1. config.twilio?.phoneNumber
 *   2. ""
 */
export function resolveTwilioPhoneNumber(): string {
  try {
    const config = loadConfig();
    if (config.twilio?.phoneNumber) return config.twilio.phoneNumber;
  } catch {
    // Config may not be available yet during early startup
  }

  return "";
}

export async function getTwilioConfig(): Promise<TwilioConfig> {
  const config = loadConfig();
  const accountSid = config.twilio?.accountSid || "";
  const authToken =
    (await getSecureKeyAsync(credentialKey("twilio", "auth_token"))) || "";
  const phoneNumber = resolveTwilioPhoneNumber();
  const webhookBaseUrl = getPublicBaseUrl(config);

  let wssBaseUrl: string;
  try {
    wssBaseUrl = getTwilioRelayUrl(config);
  } catch {
    wssBaseUrl = "";
  }

  if (!accountSid || !authToken) {
    throw new ConfigError(
      "Twilio credentials not configured. Set twilio.accountSid via config and store auth token via credential store.",
    );
  }
  if (!phoneNumber) {
    throw new ConfigError("Twilio phone number not configured.");
  }

  log.debug("Twilio config loaded successfully");

  return { accountSid, authToken, phoneNumber, webhookBaseUrl, wssBaseUrl };
}
