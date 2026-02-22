/**
 * Reusable Twilio REST API helpers.
 *
 * Provides low-level building blocks (auth header, base URL, credential
 * resolution) shared across the voice provider, SMS channel, and IPC
 * config handler. Uses fetch() directly — no twilio npm package.
 */

import { getSecureKey } from '../security/secure-keys.js';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/** Resolve Twilio credentials from the secure key store. Throws if not configured. */
export function getTwilioCredentials(): TwilioCredentials {
  const accountSid = getSecureKey('credential:twilio:account_sid');
  const authToken = getSecureKey('credential:twilio:auth_token');
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio credentials not configured. Set credential:twilio:account_sid and credential:twilio:auth_token via the credential_store tool.',
    );
  }
  return { accountSid, authToken };
}

/** Check whether Twilio credentials are present (non-throwing). */
export function hasTwilioCredentials(): boolean {
  return !!getSecureKey('credential:twilio:account_sid') && !!getSecureKey('credential:twilio:auth_token');
}

/** Build the HTTP Basic auth header for Twilio API requests. */
export function twilioAuthHeader(accountSid: string, authToken: string): string {
  return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
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
  const res = await fetch(`${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers.json`, {
    method: 'GET',
    headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio API error ${res.status}: ${text}`);
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
  const params = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true' });
  if (areaCode) params.set('AreaCode', areaCode);

  const res = await fetch(
    `${twilioBaseUrl(accountSid)}/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?${params.toString()}`,
    {
      method: 'GET',
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio API error ${res.status}: ${text}`);
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

  const res = await fetch(`${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: {
      Authorization: twilioAuthHeader(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    phone_number: string;
    friendly_name: string;
    capabilities: { voice: boolean; sms: boolean };
  };

  return {
    phoneNumber: data.phone_number,
    friendlyName: data.friendly_name,
    capabilities: { voice: data.capabilities.voice, sms: data.capabilities.sms },
  };
}
