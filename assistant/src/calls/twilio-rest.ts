/**
 * Reusable Twilio REST API helpers.
 *
 * Provides low-level building blocks (auth header, base URL, credential
 * resolution) shared across the voice provider and IPC config handler.
 * Uses fetch() directly — no twilio npm package.
 */

import { loadConfig } from "../config/loader.js";
import { getSecureKey } from "../security/secure-keys.js";
import { ConfigError, ProviderError } from "../util/errors.js";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/**
 * Resolve the Twilio Account SID from config.
 * Returns undefined if not found.
 */
function resolveAccountSid(): string | undefined {
  try {
    const config = loadConfig();
    if (config.twilio?.accountSid) return config.twilio.accountSid;
  } catch {
    // Config may not be available during early startup
  }
  return undefined;
}

/** Resolve Twilio credentials from config and secure key store. Throws if not configured. */
export function getTwilioCredentials(): TwilioCredentials {
  const accountSid = resolveAccountSid();
  const authToken = getSecureKey("credential:twilio:auth_token");
  if (!accountSid || !authToken) {
    throw new ConfigError(
      "Twilio credentials not configured. Set twilio.accountSid via config and credential:twilio:auth_token via the credential_store tool.",
    );
  }
  return { accountSid, authToken };
}

/** Check whether Twilio credentials are present (non-throwing). */
export function hasTwilioCredentials(): boolean {
  return (
    !!resolveAccountSid() && !!getSecureKey("credential:twilio:auth_token")
  );
}

/** Build the HTTP Basic auth header for Twilio API requests. */
export function twilioAuthHeader(
  accountSid: string,
  authToken: string,
): string {
  return (
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")
  );
}

/** Build the Twilio REST API base URL for a given account. */
export function twilioBaseUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
}

export interface TwilioPhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: { voice: boolean; sms: boolean };
}

/** List incoming phone numbers owned by the account. */
export async function listIncomingPhoneNumbers(
  accountSid: string,
  authToken: string,
): Promise<TwilioPhoneNumber[]> {
  const res = await fetch(
    `${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers.json`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio API error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as {
    incoming_phone_numbers: Array<{
      phone_number: string;
      friendly_name: string;
      capabilities: { voice: boolean; sms: boolean };
    }>;
  };

  return data.incoming_phone_numbers.map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    capabilities: { voice: n.capabilities.voice, sms: n.capabilities.sms },
  }));
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: { voice: boolean; sms: boolean };
}

/** Search for available phone numbers to purchase. */
export async function searchAvailableNumbers(
  accountSid: string,
  authToken: string,
  country: string,
  areaCode?: string,
): Promise<AvailablePhoneNumber[]> {
  const params = new URLSearchParams({
    SmsEnabled: "true",
    VoiceEnabled: "true",
  });
  if (areaCode) params.set("AreaCode", areaCode);

  const res = await fetch(
    `${twilioBaseUrl(accountSid)}/AvailablePhoneNumbers/${encodeURIComponent(
      country,
    )}/Local.json?${params.toString()}`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio API error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as {
    available_phone_numbers: Array<{
      phone_number: string;
      friendly_name: string;
      capabilities: { voice: boolean; sms: boolean };
    }>;
  };

  return data.available_phone_numbers.map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    capabilities: { voice: n.capabilities.voice, sms: n.capabilities.sms },
  }));
}

/** Provision (buy) a phone number. Returns the purchased number details. */
export async function provisionPhoneNumber(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<TwilioPhoneNumber> {
  const body = new URLSearchParams({ PhoneNumber: phoneNumber });

  const res = await fetch(
    `${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio API error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as {
    phone_number: string;
    friendly_name: string;
    capabilities: { voice: boolean; sms: boolean };
  };

  return {
    phoneNumber: data.phone_number,
    friendlyName: data.friendly_name,
    capabilities: {
      voice: data.capabilities.voice,
      sms: data.capabilities.sms,
    },
  };
}

export interface WebhookUrls {
  voiceUrl: string;
  statusCallbackUrl: string;
  smsUrl: string;
}

/**
 * Update the webhook URLs on a Twilio IncomingPhoneNumber.
 *
 * Configures voice webhook, voice status callback, and SMS webhook so
 * that Twilio routes inbound calls and messages to the assistant's
 * gateway endpoints.
 */
export async function updatePhoneNumberWebhooks(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
  webhooks: WebhookUrls,
): Promise<void> {
  // First, find the SID for this phone number
  const listRes = await fetch(
    `${twilioBaseUrl(
      accountSid,
    )}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
      phoneNumber,
    )}`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!listRes.ok) {
    const text = await listRes.text();
    throw new ProviderError(
      `Twilio API error ${listRes.status} looking up phone number: ${text}`,
      "twilio",
      listRes.status,
    );
  }

  const listData = (await listRes.json()) as {
    incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
  };

  const match = listData.incoming_phone_numbers.find(
    (n) => n.phone_number === phoneNumber,
  );
  if (!match) {
    throw new ProviderError(
      `Phone number ${phoneNumber} not found on Twilio account ${accountSid}`,
      "twilio",
    );
  }

  // Update the phone number's webhook configuration
  const body = new URLSearchParams({
    VoiceUrl: webhooks.voiceUrl,
    VoiceMethod: "POST",
    StatusCallback: webhooks.statusCallbackUrl,
    StatusCallbackMethod: "POST",
    SmsUrl: webhooks.smsUrl,
    SmsMethod: "POST",
  });

  const updateRes = await fetch(
    `${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers/${match.sid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );

  if (!updateRes.ok) {
    const text = await updateRes.text();
    throw new ProviderError(
      `Twilio API error ${updateRes.status} updating webhooks: ${text}`,
      "twilio",
      updateRes.status,
    );
  }
}

/**
 * Get the SID for an incoming phone number.
 * Looks up the number via `IncomingPhoneNumbers.json?PhoneNumber=...`.
 */
export async function getPhoneNumberSid(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<string | null> {
  const res = await fetch(
    `${twilioBaseUrl(
      accountSid,
    )}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
      phoneNumber,
    )}`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio API error ${res.status} looking up phone number SID: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as {
    incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
  };

  const match = data.incoming_phone_numbers.find(
    (n) => n.phone_number === phoneNumber,
  );
  return match?.sid ?? null;
}

/**
 * Release (delete) an incoming phone number from the Twilio account.
 * Looks up the SID by phone number then sends a DELETE request.
 */
export async function releasePhoneNumber(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<void> {
  const sid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
  if (!sid) {
    throw new ProviderError(
      `Phone number ${phoneNumber} not found on Twilio account ${accountSid}`,
      "twilio",
    );
  }

  const res = await fetch(
    `${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers/${sid}.json`,
    {
      method: "DELETE",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio API error ${res.status} releasing phone number: ${text}`,
      "twilio",
      res.status,
    );
  }
}
