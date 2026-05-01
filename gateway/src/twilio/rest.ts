import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("twilio-rest");

export type TwilioPhoneNumberWebhookUrls = {
  voiceUrl: string;
  statusCallbackUrl: string;
};

function twilioAuthHeader(accountSid: string, authToken: string): string {
  return (
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")
  );
}

function twilioBaseUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
}

async function lookupIncomingPhoneNumberSid(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<string | undefined> {
  const response = await fetchImpl(
    `${twilioBaseUrl(
      accountSid,
    )}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
      phoneNumber,
    )}`,
    {
      method: "GET",
      headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn(
      { status: response.status, detail },
      "Twilio phone number lookup failed",
    );
    return undefined;
  }

  const data = (await response.json().catch(() => undefined)) as
    | {
        incoming_phone_numbers?: Array<{
          sid?: string;
          phone_number?: string;
        }>;
      }
    | undefined;

  const match = data?.incoming_phone_numbers?.find(
    (number) => number.phone_number === phoneNumber && number.sid,
  );
  return match?.sid;
}

async function updateIncomingPhoneNumberWebhooks(
  accountSid: string,
  authToken: string,
  phoneNumberSid: string,
  urls: TwilioPhoneNumberWebhookUrls,
): Promise<boolean> {
  const body = new URLSearchParams({
    VoiceUrl: urls.voiceUrl,
    VoiceMethod: "POST",
    StatusCallback: urls.statusCallbackUrl,
    StatusCallbackMethod: "POST",
  });

  const response = await fetchImpl(
    `${twilioBaseUrl(accountSid)}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (response.ok) return true;

  const detail = await response.text().catch(() => "");
  log.warn(
    { status: response.status, detail },
    "Twilio phone number webhook update failed",
  );
  return false;
}

export async function updatePhoneNumberWebhooks(
  accountSid: string,
  authToken: string,
  phoneNumber: string,
  urls: TwilioPhoneNumberWebhookUrls,
): Promise<boolean> {
  const phoneNumberSid = await lookupIncomingPhoneNumberSid(
    accountSid,
    authToken,
    phoneNumber,
  );
  if (!phoneNumberSid) return false;

  return updateIncomingPhoneNumberWebhooks(
    accountSid,
    authToken,
    phoneNumberSid,
    urls,
  );
}
