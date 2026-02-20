/**
 * Centralized URL builders for all public-facing ingress endpoints.
 *
 * Resolves the canonical public base URL via a fallback chain:
 *   ingress.publicBaseUrl → calls.webhookBaseUrl → env TWILIO_WEBHOOK_BASE_URL
 *
 * Supersedes the per-domain URL helpers in calls/twilio-webhook-urls.ts.
 */

import { getLogger } from '../util/logger.js';

const log = getLogger('public-ingress-urls');

export interface IngressConfig {
  ingress?: { publicBaseUrl?: string };
  calls?: { webhookBaseUrl?: string };
}

/**
 * Trim whitespace and strip trailing slashes from a URL string.
 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolve the canonical public base URL with a three-level fallback chain:
 *   1. ingress.publicBaseUrl (preferred)
 *   2. calls.webhookBaseUrl (backward compat)
 *   3. TWILIO_WEBHOOK_BASE_URL env var (legacy, deprecated)
 *
 * Throws if no source provides a non-empty value.
 */
export function getPublicBaseUrl(config: IngressConfig): string {
  const ingressValue = config.ingress?.publicBaseUrl;
  if (ingressValue) {
    const normalized = normalizeUrl(ingressValue);
    if (normalized) return normalized;
  }

  const callsValue = config.calls?.webhookBaseUrl;
  if (callsValue) {
    const normalized = normalizeUrl(callsValue);
    if (normalized) {
      log.warn(
        'Using calls.webhookBaseUrl as public base URL — set ingress.publicBaseUrl instead.',
      );
      return normalized;
    }
  }

  const envValue = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (envValue) {
    log.warn(
      'TWILIO_WEBHOOK_BASE_URL env var is deprecated — set ingress.publicBaseUrl in config instead.',
    );
    const normalized = normalizeUrl(envValue);
    if (normalized) return normalized;
  }

  throw new Error(
    'No public base URL configured. Set ingress.publicBaseUrl in config, calls.webhookBaseUrl, or TWILIO_WEBHOOK_BASE_URL env var.',
  );
}

/**
 * Build the Twilio voice webhook URL for a given call session.
 */
export function getTwilioVoiceWebhookUrl(config: IngressConfig, callSessionId: string): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/twilio/voice?callSessionId=${callSessionId}`;
}

/**
 * Build the Twilio status callback URL.
 */
export function getTwilioStatusCallbackUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/twilio/status`;
}

/**
 * Build the Twilio connect-action callback URL.
 */
export function getTwilioConnectActionUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/twilio/connect-action`;
}

/**
 * Build the Twilio ConversationRelay WebSocket URL.
 * Converts http:// → ws:// and https:// → wss://.
 */
export function getTwilioRelayUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  const wsBase = base.replace(/^http(s?)/, 'ws$1');
  return `${wsBase}/webhooks/twilio/relay`;
}

/**
 * Build the OAuth callback URL.
 */
export function getOAuthCallbackUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/oauth/callback`;
}
