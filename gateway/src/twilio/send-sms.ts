import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("twilio-send-sms");

/**
 * Send an SMS message via the Twilio Messages API.
 * Requires `twilioAccountSid`, `twilioAuthToken`, and `twilioPhoneNumber`
 * to be configured. Silently returns if any are missing.
 */
export async function sendSmsReply(
  config: GatewayConfig,
  to: string,
  body: string,
): Promise<void> {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
    log.warn("Cannot send SMS reply: Twilio credentials not configured");
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;
  const params = new URLSearchParams({
    From: config.twilioPhoneNumber,
    To: to,
    Body: body,
  });
  const authHeader =
    "Basic " + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio Messages API error ${response.status}: ${text}`);
  }
}
