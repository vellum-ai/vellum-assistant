import { getLogger } from '../util/logger.js';

const log = getLogger('twilio-webhook-urls');

/**
 * Resolve the webhook base URL from config, falling back to the
 * TWILIO_WEBHOOK_BASE_URL environment variable with a deprecation warning.
 * Throws if neither source provides a value.
 */
export function getWebhookBaseUrl(config: { calls: { webhookBaseUrl?: string } }): string {
  const configValue = config.calls.webhookBaseUrl;
  if (configValue) {
    return normalizeBaseUrl(configValue);
  }

  const envValue = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (envValue) {
    log.warn(
      'TWILIO_WEBHOOK_BASE_URL env var is deprecated — set calls.webhookBaseUrl in config instead.',
    );
    return normalizeBaseUrl(envValue);
  }

  throw new Error(
    'No webhook base URL configured. Set calls.webhookBaseUrl in config or TWILIO_WEBHOOK_BASE_URL env var.',
  );
}

/**
 * Trim whitespace and strip trailing slash from a URL string.
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Build the Twilio voice webhook URL for a given call session.
 */
export function buildTwilioVoiceWebhookUrl(baseUrl: string, callSessionId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/webhooks/twilio/voice?callSessionId=${callSessionId}`;
}

/**
 * Build the Twilio status callback URL.
 */
export function buildTwilioStatusCallbackUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/webhooks/twilio/status`;
}
