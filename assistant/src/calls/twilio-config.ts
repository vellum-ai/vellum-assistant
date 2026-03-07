import { getTwilioPhoneNumberEnv } from "../config/env.js";
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

/**
 * Resolve the Twilio phone number using a unified fallback chain so that
 * all callers (calls, SMS adapter, readiness checks, invite transports)
 * agree on the same number.
 *
 * Resolution order:
 *   1. TWILIO_PHONE_NUMBER env var
 *   2. config.twilio?.phoneNumber
 *   3. secure store credential:twilio:phone_number  (legacy)
 *   4. ""
 */
export function resolveTwilioPhoneNumber(): string {
  const fromEnv = getTwilioPhoneNumberEnv();
  if (fromEnv) return fromEnv;

  try {
    const config = loadConfig();
    if (config.twilio?.phoneNumber) return config.twilio.phoneNumber;
  } catch {
    // Config may not be available yet during early startup
  }

  return getSecureKey("credential:twilio:phone_number") || "";
}

export function getTwilioConfig(): TwilioConfig {
  const config = loadConfig();
  const accountSid = config.twilio?.accountSid || "";
  const authToken = getSecureKey("credential:twilio:auth_token");
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
      "Twilio credentials not configured. Set twilio.accountSid via config and twilio:auth_token via the credential_store tool.",
    );
  }
  if (!phoneNumber) {
    throw new ConfigError("Twilio phone number not configured.");
  }

  log.debug("Twilio config loaded successfully");

  return { accountSid, authToken, phoneNumber, webhookBaseUrl, wssBaseUrl };
}
