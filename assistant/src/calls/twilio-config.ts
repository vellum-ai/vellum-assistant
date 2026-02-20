import { getSecureKey } from '../security/secure-keys.js';
import { getLogger } from '../util/logger.js';

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
  const webhookBaseUrl = process.env.TWILIO_WEBHOOK_BASE_URL || '';
  const wssBaseUrl = process.env.TWILIO_WSS_BASE_URL || '';

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not configured. Set credential:twilio:account_sid and credential:twilio:auth_token via the credential_store tool.');
  }
  if (!phoneNumber) {
    throw new Error('TWILIO_PHONE_NUMBER not configured.');
  }
  if (!webhookBaseUrl) {
    throw new Error('TWILIO_WEBHOOK_BASE_URL not configured.');
  }

  log.debug('Twilio config loaded successfully');

  return { accountSid, authToken, phoneNumber, webhookBaseUrl, wssBaseUrl };
}
