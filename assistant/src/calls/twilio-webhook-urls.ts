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
 * Resolve the webhook base URL from config via ingress.publicBaseUrl
 * or INGRESS_PUBLIC_BASE_URL env var. Throws if no value is configured.
 *
 * @deprecated Use `getPublicBaseUrl` from `inbound/public-ingress-urls.ts` instead.
 */
export function getWebhookBaseUrl(config: { ingress?: { publicBaseUrl?: string } }): string {
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
