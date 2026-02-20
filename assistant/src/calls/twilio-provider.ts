import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../util/logger.js';
import { getSecureKey } from '../security/secure-keys.js';
import type { VoiceProvider, InitiateCallOptions } from './voice-provider.js';

const log = getLogger('twilio-provider');

/**
 * Twilio ConversationRelay voice provider.
 *
 * Uses the Twilio REST API directly via fetch() — no twilio npm package.
 * Credentials are resolved lazily from the secure key store on each call.
 */
export class TwilioConversationRelayProvider implements VoiceProvider {
  readonly name = 'twilio';

  // ── Credential helpers ──────────────────────────────────────────────

  private getCredentials(): { accountSid: string; authToken: string } {
    const accountSid = getSecureKey('credential:twilio:account_sid');
    const authToken = getSecureKey('credential:twilio:auth_token');
    if (!accountSid || !authToken) {
      throw new Error(
        'Twilio credentials not configured. Set credential:twilio:account_sid and credential:twilio:auth_token via the credential_store tool.',
      );
    }
    return { accountSid, authToken };
  }

  private authHeader(accountSid: string, authToken: string): string {
    return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  }

  private baseUrl(accountSid: string): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  }

  // ── VoiceProvider interface ─────────────────────────────────────────

  async initiateCall(opts: InitiateCallOptions): Promise<{ callSid: string }> {
    const { accountSid, authToken } = this.getCredentials();

    const body = new URLSearchParams({
      From: opts.from,
      To: opts.to,
      Url: opts.webhookUrl,
      StatusCallback: opts.statusCallbackUrl,
      StatusCallbackEvent: 'initiated ringing answered completed',
    });

    const reservedKeys = new Set(['From', 'To', 'Url', 'StatusCallback', 'StatusCallbackEvent']);
    if (opts.customParams) {
      for (const [key, value] of Object.entries(opts.customParams)) {
        if (reservedKeys.has(key)) {
          log.warn({ key }, 'Ignoring reserved Twilio parameter in customParams');
          continue;
        }
        body.set(key, value);
      }
    }

    log.info({ from: opts.from, to: opts.to }, 'Initiating Twilio call');

    const res = await fetch(`${this.baseUrl(accountSid)}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, body: text }, 'Twilio initiateCall failed');
      throw new Error(`Twilio API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { sid: string };
    log.info({ callSid: data.sid }, 'Twilio call initiated');
    return { callSid: data.sid };
  }

  async endCall(callSid: string): Promise<void> {
    const { accountSid, authToken } = this.getCredentials();

    log.info({ callSid }, 'Ending Twilio call');

    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(`${this.baseUrl(accountSid)}/Calls/${callSid}.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, body: text, callSid }, 'Twilio endCall failed');
      throw new Error(`Twilio API error ${res.status}: ${text}`);
    }

    log.info({ callSid }, 'Twilio call ended');
  }

  async getCallStatus(callSid: string): Promise<string> {
    const { accountSid, authToken } = this.getCredentials();

    const res = await fetch(`${this.baseUrl(accountSid)}/Calls/${callSid}.json`, {
      method: 'GET',
      headers: {
        Authorization: this.authHeader(accountSid, authToken),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, body: text, callSid }, 'Twilio getCallStatus failed');
      throw new Error(`Twilio API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { status: string };
    return data.status;
  }

  // ── Webhook signature verification ──────────────────────────────────

  /**
   * Returns the Twilio auth token from the secure key store, or null if
   * not configured. Exposed as a static method so callers (e.g. the
   * HTTP server webhook middleware) can check availability independently.
   */
  static getAuthToken(): string | null {
    return getSecureKey('credential:twilio:auth_token') ?? null;
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

    const computed = createHmac('sha1', authToken)
      .update(data)
      .digest('base64');

    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
