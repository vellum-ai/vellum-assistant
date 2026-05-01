/**
 * Reusable Twilio REST API helpers.
 *
 * Provides low-level building blocks (auth header, base URL, credential
 * resolution) shared across the voice provider and the
 * config handler. Uses fetch() directly — no twilio npm package.
 */

import {
  lookupIncomingPhoneNumberSid,
  twilioAuthHeader,
  twilioBaseUrl,
  TwilioRestError,
  type TwilioWebhookUrls,
  updatePhoneNumberWebhooks as updateTwilioPhoneNumberWebhooks,
} from "@vellumai/twilio-client";

import { loadConfig } from "../config/loader.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { ConfigError, ProviderError } from "../util/errors.js";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/** Resolve the Twilio Account SID from config. */
function resolveAccountSid(): string | undefined {
  try {
    const config = loadConfig();
    return config.twilio?.accountSid || undefined;
  } catch {
    // Config may not be available during early startup
    return undefined;
  }
}

/** Resolve the Twilio Auth Token from the credential store. */
async function resolveAuthToken(): Promise<string | undefined> {
  return (
    (await getSecureKeyAsync(credentialKey("twilio", "auth_token"))) ||
    undefined
  );
}

/** Resolve Twilio credentials from config (SID) and credential store (token). Throws if not configured. */
export async function getTwilioCredentials(): Promise<TwilioCredentials> {
  const accountSid = resolveAccountSid();
  const authToken = await resolveAuthToken();
  if (!accountSid || !authToken) {
    throw new ConfigError(
      "Twilio credentials not configured. Set twilio.accountSid via config and store auth token via credential store.",
    );
  }
  return { accountSid, authToken };
}

/** Check whether Twilio credentials are present (non-throwing). */
export async function hasTwilioCredentials(): Promise<boolean> {
  try {
    return !!resolveAccountSid() && !!(await resolveAuthToken());
  } catch {
    return false;
  }
}

export { twilioAuthHeader, twilioBaseUrl };

export interface TwilioPhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: { voice: boolean };
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
      capabilities: { voice: boolean };
    }>;
  };

  return data.incoming_phone_numbers.map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    capabilities: { voice: n.capabilities.voice },
  }));
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: { voice: boolean };
}

/** Search for available phone numbers to purchase. */
export async function searchAvailableNumbers(
  accountSid: string,
  authToken: string,
  country: string,
  areaCode?: string,
): Promise<AvailablePhoneNumber[]> {
  const params = new URLSearchParams({
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
      capabilities: { voice: boolean };
    }>;
  };

  return data.available_phone_numbers.map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    capabilities: { voice: n.capabilities.voice },
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
    capabilities: { voice: boolean };
  };

  return {
    phoneNumber: data.phone_number,
    friendlyName: data.friendly_name,
    capabilities: {
      voice: data.capabilities.voice,
    },
  };
}

export type WebhookUrls = TwilioWebhookUrls;

function rethrowAsProviderError(err: unknown): never {
  if (err instanceof TwilioRestError) {
    throw new ProviderError(err.message, "twilio", err.status);
  }
  throw err;
}

/**
 * Update the webhook URLs on a Twilio IncomingPhoneNumber.
 *
 * Configures voice webhook and voice status callback so that Twilio
 * routes inbound calls to the assistant's gateway endpoints.
 */
export async function updatePhoneNumberWebhooks(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
  webhooks: WebhookUrls,
): Promise<void> {
  try {
    await updateTwilioPhoneNumberWebhooks({
      accountSid,
      authToken,
      phoneNumber,
      webhooks,
    });
  } catch (err) {
    rethrowAsProviderError(err);
  }
}

/**
 * Get the SID for an incoming phone number.
 * Looks up the number via `IncomingPhoneNumbers.json?PhoneNumber=...`.
 */
async function getPhoneNumberSid(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<string | null> {
  try {
    return (
      (await lookupIncomingPhoneNumberSid({
        accountSid,
        authToken,
        phoneNumber,
      })) ?? null
    );
  } catch (err) {
    rethrowAsProviderError(err);
  }
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
