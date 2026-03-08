/**
 * Reusable Twilio REST API helpers.
 *
 * Provides low-level building blocks (auth header, base URL, credential
 * resolution) shared across the voice provider and IPC
 * config handler. Uses fetch() directly — no twilio npm package.
 */

import { loadConfig } from "../config/loader.js";
import { getSecureKey } from "../security/secure-keys.js";
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
function resolveAuthToken(): string | undefined {
  return getSecureKey("credential:twilio:auth_token") || undefined;
}

/** Resolve Twilio credentials from config (SID) and credential store (token). Throws if not configured. */
export function getTwilioCredentials(): TwilioCredentials {
  const accountSid = resolveAccountSid();
  const authToken = resolveAuthToken();
  if (!accountSid || !authToken) {
    throw new ConfigError(
      "Twilio credentials not configured. Set twilio.accountSid via config and store auth token via credential store.",
    );
  }
  return { accountSid, authToken };
}

/** Check whether Twilio credentials are present (non-throwing). */
export function hasTwilioCredentials(): boolean {
  try {
    return !!resolveAccountSid() && !!resolveAuthToken();
  } catch {
    return false;
  }
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

/** Fetch the current status of a Twilio message by SID. */
export async function fetchMessageStatus(
  accountSid: string,
  authToken: string,
  messageSid: string,
): Promise<{ status: string; errorCode?: string; errorMessage?: string }> {
  const res = await fetch(
    `${twilioBaseUrl(accountSid)}/Messages/${encodeURIComponent(
      messageSid,
    )}.json`,
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
    status?: string;
    error_code?: number | null;
    error_message?: string | null;
  };

  return {
    status: data.status ?? "unknown",
    errorCode: data.error_code != null ? String(data.error_code) : undefined,
    errorMessage: data.error_message ?? undefined,
  };
}

export interface WebhookUrls {
  voiceUrl: string;
  statusCallbackUrl: string;
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

// ── Toll-Free Verification ──────────────────────────────────────────────

/** Twilio Messaging API base URL for toll-free verification endpoints. */
const TOLLFREE_VERIFICATION_BASE =
  "https://messaging.twilio.com/v1/Tollfree/Verifications";

export interface TollFreeVerification {
  sid: string;
  status: string;
  rejectionReason?: string;
  rejectionReasons?: string[];
  errorCode?: string;
  editAllowed?: boolean;
  editExpiration?: string;
  regulationType?: string;
}

function parseTollFreeVerification(
  raw: Record<string, unknown>,
): TollFreeVerification {
  return {
    sid: raw.sid as string,
    status: raw.status as string,
    rejectionReason: (raw.rejection_reason as string) ?? undefined,
    rejectionReasons: (raw.rejection_reasons as string[]) ?? undefined,
    errorCode: raw.error_code != null ? String(raw.error_code) : undefined,
    editAllowed: (raw.edit_allowed as boolean) ?? undefined,
    editExpiration: (raw.edit_expiration as string) ?? undefined,
    regulationType: (raw.regulation_type as string) ?? undefined,
  };
}

/**
 * Get toll-free verification status for a phone number.
 * If `phoneNumberSid` is provided, filters by that SID; otherwise returns the
 * first verification found.
 */
export async function getTollFreeVerificationStatus(
  accountSid: string,
  authToken: string,
  phoneNumberSid?: string,
): Promise<TollFreeVerification | null> {
  const params = new URLSearchParams();
  if (phoneNumberSid) params.set("TollfreePhoneNumberSid", phoneNumberSid);

  const url = params.toString()
    ? `${TOLLFREE_VERIFICATION_BASE}?${params.toString()}`
    : TOLLFREE_VERIFICATION_BASE;

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio Toll-Free Verification API error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as {
    verifications?: Array<Record<string, unknown>>;
  };
  const verifications = data.verifications ?? [];
  if (verifications.length === 0) return null;

  return parseTollFreeVerification(verifications[0]);
}

/** Fetch a specific toll-free verification by SID. */
export async function getTollFreeVerificationBySid(
  accountSid: string,
  authToken: string,
  verificationSid: string,
): Promise<TollFreeVerification | null> {
  const res = await fetch(
    `${TOLLFREE_VERIFICATION_BASE}/${encodeURIComponent(verificationSid)}`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio Toll-Free Verification fetch error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parseTollFreeVerification(data);
}

export interface TollFreeVerificationSubmitParams {
  tollfreePhoneNumberSid: string;
  businessName: string;
  businessWebsite: string;
  notificationEmail: string;
  useCaseCategories: string[];
  useCaseSummary: string;
  productionMessageSample: string;
  optInImageUrls: string[];
  optInType: string;
  messageVolume: string;
  businessType?: string;
  customerProfileSid?: string;
}

/** Submit a new toll-free verification request. */
export async function submitTollFreeVerification(
  accountSid: string,
  authToken: string,
  params: TollFreeVerificationSubmitParams,
): Promise<TollFreeVerification> {
  const body = new URLSearchParams();
  body.set("TollfreePhoneNumberSid", params.tollfreePhoneNumberSid);
  body.set("BusinessName", params.businessName);
  body.set("BusinessWebsite", params.businessWebsite);
  body.set("NotificationEmail", params.notificationEmail);
  body.set("UseCaseSummary", params.useCaseSummary);
  body.set("ProductionMessageSample", params.productionMessageSample);
  body.set("OptInType", params.optInType);
  body.set("MessageVolume", params.messageVolume);
  body.set("BusinessType", params.businessType ?? "SOLE_PROPRIETOR");

  for (const cat of params.useCaseCategories) {
    body.append("UseCaseCategories", cat);
  }
  for (const url of params.optInImageUrls) {
    body.append("OptInImageUrls", url);
  }
  if (params.customerProfileSid) {
    body.set("CustomerProfileSid", params.customerProfileSid);
  }

  const res = await fetch(TOLLFREE_VERIFICATION_BASE, {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(accountSid, authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio Toll-Free Verification submit error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parseTollFreeVerification(data);
}

/** Update an existing toll-free verification. */
export async function updateTollFreeVerification(
  accountSid: string,
  authToken: string,
  verificationSid: string,
  params: Partial<TollFreeVerificationSubmitParams>,
): Promise<TollFreeVerification> {
  const body = new URLSearchParams();
  if (params.businessName) body.set("BusinessName", params.businessName);
  if (params.businessWebsite)
    body.set("BusinessWebsite", params.businessWebsite);
  if (params.notificationEmail)
    body.set("NotificationEmail", params.notificationEmail);
  if (params.useCaseSummary) body.set("UseCaseSummary", params.useCaseSummary);
  if (params.productionMessageSample)
    body.set("ProductionMessageSample", params.productionMessageSample);
  if (params.optInType) body.set("OptInType", params.optInType);
  if (params.messageVolume) body.set("MessageVolume", params.messageVolume);
  if (params.businessType) body.set("BusinessType", params.businessType);
  if (params.useCaseCategories) {
    for (const cat of params.useCaseCategories) {
      body.append("UseCaseCategories", cat);
    }
  }
  if (params.optInImageUrls) {
    for (const url of params.optInImageUrls) {
      body.append("OptInImageUrls", url);
    }
  }
  if (params.customerProfileSid)
    body.set("CustomerProfileSid", params.customerProfileSid);

  const res = await fetch(
    `${TOLLFREE_VERIFICATION_BASE}/${encodeURIComponent(verificationSid)}`,
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
      `Twilio Toll-Free Verification update error ${res.status}: ${text}`,
      "twilio",
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parseTollFreeVerification(data);
}

/** Delete a toll-free verification. */
export async function deleteTollFreeVerification(
  accountSid: string,
  authToken: string,
  verificationSid: string,
): Promise<void> {
  const res = await fetch(
    `${TOLLFREE_VERIFICATION_BASE}/${encodeURIComponent(verificationSid)}`,
    {
      method: "DELETE",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(
      `Twilio Toll-Free Verification delete error ${res.status}: ${text}`,
      "twilio",
      res.status,
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
