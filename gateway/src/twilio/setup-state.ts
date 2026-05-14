import type { ConfigFileCache } from "../config-file-cache.js";

const TWILIO_SETUP_STARTED_FIELD = "setupStarted";

type TwilioCredentialRecord = Record<string, string> | null | undefined;

function hasTwilioCredentialRecord(
  credentials: TwilioCredentialRecord,
): boolean {
  return !!(
    credentials?.account_sid?.trim() && credentials?.auth_token?.trim()
  );
}

export function hasTwilioSetupStarted(
  configFile: ConfigFileCache,
  credentials?: TwilioCredentialRecord,
): boolean {
  if (hasTwilioCredentialRecord(credentials)) {
    return true;
  }

  if (
    configFile.getBoolean("twilio", TWILIO_SETUP_STARTED_FIELD, {
      force: true,
    }) === true
  ) {
    return true;
  }

  return !!(
    configFile.getString("twilio", "accountSid")?.trim() ||
    configFile.getString("twilio", "phoneNumber")?.trim()
  );
}
