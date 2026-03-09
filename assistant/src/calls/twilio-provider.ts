import { createHmac, timingSafeEqual } from "node:crypto";

import { getSecureKey } from "../security/secure-keys.js";
import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  getTwilioCredentials,
  twilioAuthHeader,
  twilioBaseUrl,
} from "./twilio-rest.js";
import type { InitiateCallOptions, VoiceProvider } from "./voice-provider.js";

const log = getLogger("twilio-provider");

/**
 * Twilio ConversationRelay voice provider.
 *
 * Uses the Twilio REST API directly via fetch() — no twilio npm package.
 * Credentials are resolved lazily from config on each call.
 */
export class TwilioConversationRelayProvider implements VoiceProvider {
  readonly name = "twilio";

  // ── Credential helpers ──────────────────────────────────────────────

  private getCredentials(): { accountSid: string; authToken: string } {
    return getTwilioCredentials();
  }

  private authHeader(accountSid: string, authToken: string): string {
    return twilioAuthHeader(accountSid, authToken);
  }

  private baseUrl(accountSid: string): string {
    return twilioBaseUrl(accountSid);
  }

  // ── VoiceProvider interface ─────────────────────────────────────────

  async initiateCall(opts: InitiateCallOptions): Promise<{ callSid: string }> {
    const { accountSid, authToken } = this.getCredentials();

    const body = new URLSearchParams({
      From: opts.from,
      To: opts.to,
      Url: opts.webhookUrl,
      StatusCallback: opts.statusCallbackUrl,
    });
    // Twilio expects repeated StatusCallbackEvent params, not a single
    // space-delimited string.
    body.append("StatusCallbackEvent", "initiated");
    body.append("StatusCallbackEvent", "ringing");
    body.append("StatusCallbackEvent", "answered");
    body.append("StatusCallbackEvent", "completed");

    const reservedKeys = new Set([
      "From",
      "To",
      "Url",
      "StatusCallback",
      "StatusCallbackEvent",
    ]);
    if (opts.customParams) {
      for (const [key, value] of Object.entries(opts.customParams)) {
        if (reservedKeys.has(key)) {
          log.warn(
            { key },
            "Ignoring reserved Twilio parameter in customParams",
          );
          continue;
        }
        body.set(key, value);
      }
    }

    log.info({ from: opts.from, to: opts.to }, "Initiating Twilio call");

    const res = await fetch(`${this.baseUrl(accountSid)}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error(
        { status: res.status, body: text },
        "Twilio initiateCall failed",
      );
      throw new ProviderError(
        `Twilio API error ${res.status}: ${text}`,
        "twilio",
        res.status,
      );
    }

    const data = (await res.json()) as { sid: string };
    log.info({ callSid: data.sid }, "Twilio call initiated");
    return { callSid: data.sid };
  }

  async endCall(callSid: string): Promise<void> {
    const { accountSid, authToken } = this.getCredentials();

    log.info({ callSid }, "Ending Twilio call");

    const body = new URLSearchParams({ Status: "completed" });

    const res = await fetch(
      `${this.baseUrl(accountSid)}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader(accountSid, authToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      log.error(
        { status: res.status, body: text, callSid },
        "Twilio endCall failed",
      );
      throw new ProviderError(
        `Twilio API error ${res.status}: ${text}`,
        "twilio",
        res.status,
      );
    }

    log.info({ callSid }, "Twilio call ended");
  }

  async getCallStatus(callSid: string): Promise<string> {
    const { accountSid, authToken } = this.getCredentials();

    const res = await fetch(
      `${this.baseUrl(accountSid)}/Calls/${callSid}.json`,
      {
        method: "GET",
        headers: {
          Authorization: this.authHeader(accountSid, authToken),
        },
      },
    );

    if (!res.ok) {
      const text = await res.text();
      log.error(
        { status: res.status, body: text, callSid },
        "Twilio getCallStatus failed",
      );
      throw new ProviderError(
        `Twilio API error ${res.status}: ${text}`,
        "twilio",
        res.status,
      );
    }

    const data = (await res.json()) as { status: string };
    return data.status;
  }

  // ── Caller ID eligibility ───────────────────────────────────────────

  /**
   * Check whether a phone number can be used as an outbound caller ID
   * by the current Twilio account. A number is eligible if it appears as
   * either an Incoming Phone Number (owned) or an Outgoing Caller ID
   * (verified) on the account.
   */
  async checkCallerIdEligibility(
    phoneNumber: string,
  ): Promise<{ eligible: boolean; reason?: string }> {
    const { accountSid, authToken } = this.getCredentials();
    const encodedNumber = encodeURIComponent(phoneNumber);

    let incomingOk = false;
    let outgoingOk = false;

    // Check incoming phone numbers (owned by this account)
    const incomingRes = await fetch(
      `${this.baseUrl(
        accountSid,
      )}/IncomingPhoneNumbers.json?PhoneNumber=${encodedNumber}`,
      {
        method: "GET",
        headers: {
          Authorization: this.authHeader(accountSid, authToken),
        },
      },
    );

    if (incomingRes.ok) {
      incomingOk = true;
      const incomingData = (await incomingRes.json()) as {
        incoming_phone_numbers: unknown[];
      };
      if (incomingData.incoming_phone_numbers.length > 0) {
        log.info(
          { phoneNumber },
          "Number found in IncomingPhoneNumbers — eligible as caller ID",
        );
        return { eligible: true };
      }
    } else {
      log.warn(
        { status: incomingRes.status, phoneNumber },
        "Failed to query IncomingPhoneNumbers — falling through to OutgoingCallerIds",
      );
    }

    // Check outgoing caller IDs (verified with this account)
    const outgoingRes = await fetch(
      `${this.baseUrl(
        accountSid,
      )}/OutgoingCallerIds.json?PhoneNumber=${encodedNumber}`,
      {
        method: "GET",
        headers: {
          Authorization: this.authHeader(accountSid, authToken),
        },
      },
    );

    if (outgoingRes.ok) {
      outgoingOk = true;
      const outgoingData = (await outgoingRes.json()) as {
        outgoing_caller_ids: unknown[];
      };
      if (outgoingData.outgoing_caller_ids.length > 0) {
        log.info(
          { phoneNumber },
          "Number found in OutgoingCallerIds — eligible as caller ID",
        );
        return { eligible: true };
      }
    } else {
      log.warn(
        { status: outgoingRes.status, phoneNumber },
        "Failed to query OutgoingCallerIds",
      );
    }

    // If any API call failed, the eligibility check is inconclusive —
    // propagate as an error rather than returning a false negative.
    if (!incomingOk || !outgoingOk) {
      const failedEndpoints = [
        ...(!incomingOk ? [`IncomingPhoneNumbers: ${incomingRes.status}`] : []),
        ...(!outgoingOk ? [`OutgoingCallerIds: ${outgoingRes.status}`] : []),
      ].join(", ");
      throw new ProviderError(
        `Unable to verify caller ID eligibility for ${phoneNumber}: Twilio API error (${failedEndpoints}). The number may be eligible but could not be confirmed. Please check your Twilio credentials and try again.`,
        "twilio",
      );
    }

    log.info(
      { phoneNumber },
      "Number not found in either IncomingPhoneNumbers or OutgoingCallerIds",
    );
    return {
      eligible: false,
      reason:
        "Number is not owned by or verified with your Twilio account. To use this number as caller ID, either: (1) add it as an Incoming Phone Number, or (2) verify it as an Outgoing Caller ID in the Twilio Console.",
    };
  }

  // ── Webhook signature verification ──────────────────────────────────

  /**
   * Returns the Twilio auth token from the credential store, or null if not configured.
   * Exposed as a static method so callers (e.g. the HTTP server webhook
   * middleware) can check availability independently.
   */
  static getAuthToken(): string | null {
    return getSecureKey("credential:twilio:auth_token") || null;
  }

  /**
   * Validates an X-Twilio-Signature header using HMAC-SHA1.
   *
   * Algorithm (from Twilio docs):
   * 1. Take the full URL of the request.
   * 2. Sort the POST parameters alphabetically by key.
   * 3. Concatenate the URL with each key-value pair (key + value, no delimiters).
   * 4. HMAC-SHA1 the result using the auth token as the key.
   * 5. Base64-encode the hash.
   * 6. Compare to the X-Twilio-Signature header value.
   */
  static verifyWebhookSignature(
    url: string,
    params: Record<string, string>,
    signature: string,
    authToken: string,
  ): boolean {
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
      data += key + params[key];
    }

    const computed = createHmac("sha1", authToken)
      .update(data)
      .digest("base64");

    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
