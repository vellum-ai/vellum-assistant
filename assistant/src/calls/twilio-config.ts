import { getSecureKey } from '../security/secure-keys.js';
import { getLogger } from '../util/logger.js';
import { loadConfig } from '../config/loader.js';
import { getWebhookBaseUrl } from './twilio-webhook-urls.js';

const log = getLogger('twilio-config');

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  webhookBaseUrl: string;
  wssBaseUrl: string;
}

export function getTwilioConfig(): TwilioConfig {
  const accountSid = getSecureKey('credential:twilio:account_sid');
  const authToken = getSecureKey('credential:twilio:auth_token');
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER || getSecureKey('credential:twilio:phone_number') || '';
  const config = loadConfig();
  const webhookBaseUrl = getWebhookBaseUrl(config);
  const wssBaseUrl = process.env.TWILIO_WSS_BASE_URL || '';

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not configured. Set credential:twilio:account_sid and credential:twilio:auth_token via the credential_store tool.');
  }
  if (!phoneNumber) {
    throw new Error('TWILIO_PHONE_NUMBER not configured.');
  }

  log.debug('Twilio config loaded successfully');

  return { accountSid, authToken, phoneNumber, webhookBaseUrl, wssBaseUrl };
}
