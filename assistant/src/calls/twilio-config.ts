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
    config.twilio?.phoneNumber ||
    config.sms?.phoneNumber ||
    ""
  );
}

export function getTwilioConfig(assistantId?: string): TwilioConfig {
  const config = loadConfig();
  const accountSid = config.twilio?.accountSid || "";
  const authToken = getSecureKey("credential:twilio:auth_token");
  const phoneNumber = resolveTwilioPhoneNumber(config, assistantId);
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
