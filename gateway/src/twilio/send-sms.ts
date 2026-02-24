import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("twilio-send-sms");

/**
 * Send an SMS message via the Twilio Messages API.
 * Requires `twilioAccountSid` and `twilioAuthToken`, plus either an
 * assistant-scoped phone number mapping or `twilioPhoneNumber`.
 * Silently returns if any required values are missing.
 */
export async function sendSmsReply(
  config: GatewayConfig,
  to: string,
  body: string,
  assistantId?: string,
): Promise<void> {
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    log.warn("Cannot send SMS reply: Twilio credentials not configured");
    return;
  }

  const from = assistantId
    ? (config.assistantPhoneNumbers?.[assistantId] ?? config.twilioPhoneNumber)
    : config.twilioPhoneNumber;
  if (!from) {
    log.warn({ assistantId }, "Cannot send SMS reply: Twilio phone number not configured");
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;
  const params = new URLSearchParams({
    From: from,
    To: to,
    Body: body,
  });
  const authHeader =
    "Basic " + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio Messages API error ${response.status}: ${text}`);
  }
}
