export type TwilioFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export interface TwilioRequestOptions {
  fetchImpl?: TwilioFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TwilioWebhookUrls {
  voiceUrl: string;
  statusCallbackUrl: string;
}

export interface TwilioRestErrorOptions {
  cause?: unknown;
  status?: number;
}

export class TwilioRestError extends Error {
  readonly provider = "twilio";
  readonly status?: number;

  constructor(message: string, options: TwilioRestErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "TwilioRestError";
    this.status = options.status;
  }
}

interface IncomingPhoneNumbersResponse {
  incoming_phone_numbers?: Array<{
    phone_number?: string;
    sid?: string;
  }>;
}

function resolveFetch(fetchImpl?: TwilioFetch): TwilioFetch {
  return fetchImpl ?? fetch;
}

function resolveSignal(input: TwilioRequestOptions): AbortSignal | undefined {
  if (input.signal) return input.signal;
  return typeof input.timeoutMs === "number"
    ? AbortSignal.timeout(input.timeoutMs)
    : undefined;
}

async function safeResponseText(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

async function safeJson<T>(response: Response, context: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new TwilioRestError(`Twilio API returned invalid JSON ${context}`, {
      cause,
      status: response.status,
    });
  }
}

export function twilioAuthHeader(
  accountSid: string,
  authToken: string,
): string {
  return (
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")
  );
}

export function twilioBaseUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
}

export async function lookupIncomingPhoneNumberSid(
  input: TwilioCredentials &
    TwilioRequestOptions & {
      phoneNumber: string;
    },
): Promise<string | undefined> {
  const response = await resolveFetch(input.fetchImpl)(
    `${twilioBaseUrl(
      input.accountSid,
    )}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
      input.phoneNumber,
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: twilioAuthHeader(input.accountSid, input.authToken),
      },
      signal: resolveSignal(input),
    },
  );

  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new TwilioRestError(
      `Twilio API error ${response.status} looking up phone number: ${detail}`,
      { status: response.status },
    );
  }

  const data = await safeJson<IncomingPhoneNumbersResponse>(
    response,
    "looking up phone number",
  );
  const match = data.incoming_phone_numbers?.find(
    (number) => number.phone_number === input.phoneNumber && number.sid,
  );
  return match?.sid;
}

export async function updateIncomingPhoneNumberWebhooks(
  input: TwilioCredentials &
    TwilioRequestOptions & {
      phoneNumberSid: string;
      webhooks: TwilioWebhookUrls;
    },
): Promise<void> {
  const body = new URLSearchParams({
    VoiceUrl: input.webhooks.voiceUrl,
    VoiceMethod: "POST",
    StatusCallback: input.webhooks.statusCallbackUrl,
    StatusCallbackMethod: "POST",
  });

  const response = await resolveFetch(input.fetchImpl)(
    `${twilioBaseUrl(input.accountSid)}/IncomingPhoneNumbers/${
      input.phoneNumberSid
    }.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(input.accountSid, input.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: resolveSignal(input),
    },
  );

  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new TwilioRestError(
      `Twilio API error ${response.status} updating webhooks: ${detail}`,
      { status: response.status },
    );
  }
}

export async function updatePhoneNumberWebhooks(
  input: TwilioCredentials &
    TwilioRequestOptions & {
      phoneNumber: string;
      webhooks: TwilioWebhookUrls;
    },
): Promise<void> {
  const phoneNumberSid = await lookupIncomingPhoneNumberSid(input);
  if (!phoneNumberSid) {
    throw new TwilioRestError(
      `Phone number ${input.phoneNumber} not found on Twilio account ${input.accountSid}`,
    );
  }

  await updateIncomingPhoneNumberWebhooks({
    ...input,
    phoneNumberSid,
  });
}
