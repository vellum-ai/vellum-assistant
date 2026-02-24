import { getSecureKey } from '../security/secure-keys.js';
import { getLogger } from '../util/logger.js';
import { loadConfig } from '../config/loader.js';
import { getPublicBaseUrl, getTwilioRelayUrl } from '../inbound/public-ingress-urls.js';

const log = getLogger('twilio-config');

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  webhookBaseUrl: string;
  wssBaseUrl: string;
}

function resolveTwilioPhoneNumber(assistantId: string | undefined, config: ReturnType<typeof loadConfig>): string {
  if (assistantId) {
    const assistantPhone = config.sms?.assistantPhoneNumbers?.[assistantId];
    if (assistantPhone) {
      return assistantPhone;
    }
  }

  // Global fallback order:
  // 1. TWILIO_PHONE_NUMBER env var (explicit override)
  // 2. config file sms.phoneNumber (primary storage)
  // 3. credential:twilio:phone_number secure key (backward-compat fallback)
  return process.env.TWILIO_PHONE_NUMBER || config.sms?.phoneNumber || getSecureKey('credential:twilio:phone_number') || '';
}

export function getTwilioConfig(assistantId?: string): TwilioConfig {
  const accountSid = getSecureKey('credential:twilio:account_sid');
  const authToken = getSecureKey('credential:twilio:auth_token');
  const config = loadConfig();
  const phoneNumber = resolveTwilioPhoneNumber(assistantId, config);
  const webhookBaseUrl = getPublicBaseUrl(config);

  // Always use the centralized relay URL derived from the public ingress base URL.
  // TWILIO_WSS_BASE_URL is ignored.
  let wssBaseUrl: string;
  if (process.env.TWILIO_WSS_BASE_URL) {
    log.warn('TWILIO_WSS_BASE_URL env var is ignored. Relay URL is derived from ingress.publicBaseUrl.');
  }
  try {
    wssBaseUrl = getTwilioRelayUrl(config);
  } catch {
    wssBaseUrl = '';
  }

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not configured. Set credential:twilio:account_sid and credential:twilio:auth_token via the credential_store tool.');
  }
  if (!phoneNumber) {
    throw new Error('Twilio phone number not configured.');
  }

  log.debug('Twilio config loaded successfully');

  return { accountSid, authToken, phoneNumber, webhookBaseUrl, wssBaseUrl };
}
