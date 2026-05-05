import { loadConfig } from "../config/loader.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import { ConfigError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("twilio-config");

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
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
  const accountSid = loadConfig().twilio?.accountSid || "";
  const authTokenResult = await getSecureKeyResultAsync(
    credentialKey("twilio", "auth_token"),
  );
  const authToken = authTokenResult.value || "";
  const phoneNumber = resolveTwilioPhoneNumber();

  if (!accountSid && !authToken) {
    if (authTokenResult.unreachable) {
      throw new ConfigError(
        "Twilio credentials could not be loaded. Account SID is not configured and the credential store is unreachable (auth token cannot be verified).",
      );
    }
    throw new ConfigError(
      "Twilio credentials not configured. Set twilio.accountSid via config and store auth token via credential store.",
    );
  }
  if (!accountSid) {
    throw new ConfigError(
      "Twilio Account SID not configured. Set twilio.accountSid via config.",
    );
  }
  if (!authToken) {
    if (authTokenResult.unreachable) {
      throw new ConfigError(
        "Twilio Auth Token could not be loaded: credential store is unreachable. The token may be stored but cannot be retrieved right now.",
      );
    }
    throw new ConfigError(
      "Twilio Auth Token not configured. Store auth token via credential store.",
    );
  }
  if (!phoneNumber) {
    throw new ConfigError("Twilio phone number not configured.");
  }

  log.debug("Twilio config loaded successfully");

  return { accountSid, authToken, phoneNumber };
}
