/**
 * Twilio webhook URL helpers.
 *
 * This module is a thin backward-compat wrapper that delegates to the
 * centralized URL builders in inbound/public-ingress-urls.ts.
 */

import {
  getPublicBaseUrl,
  type IngressConfig,
} from '../inbound/public-ingress-urls.js';

/**
 * Resolve the webhook base URL from config, falling back to the
 * TWILIO_WEBHOOK_BASE_URL environment variable with a deprecation warning.
 * Throws if neither source provides a value.
 *
 * @deprecated Use `getPublicBaseUrl` from `inbound/public-ingress-urls.ts` instead.
 */
export function getWebhookBaseUrl(config: { calls: { webhookBaseUrl?: string }; ingress?: { publicBaseUrl?: string } }): string {
  return getPublicBaseUrl(config as IngressConfig);
}

/**
 * Trim whitespace and strip trailing slash from a URL string.
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Build the Twilio voice webhook URL for a given call session.
 *
 * @deprecated Use `getTwilioVoiceWebhookUrl` from `inbound/public-ingress-urls.ts` instead.
 */
export function buildTwilioVoiceWebhookUrl(baseUrl: string, callSessionId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/webhooks/twilio/voice?callSessionId=${callSessionId}`;
}

/**
 * Build the Twilio status callback URL.
 *
 * @deprecated Use `getTwilioStatusCallbackUrl` from `inbound/public-ingress-urls.ts` instead.
 */
export function buildTwilioStatusCallbackUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/webhooks/twilio/status`;
}
