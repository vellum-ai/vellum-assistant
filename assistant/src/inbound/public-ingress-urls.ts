/**
 * Centralized URL builders for all public-facing ingress endpoints.
 *
 * ## Source-of-truth precedence
 *
 * The canonical public base URL is resolved through a two-level chain:
 *
 *   1. **User Settings** (`config.ingress.publicBaseUrl`) — set via
 *      the in-chat config flow, the Settings UI, or `config set ingress.publicBaseUrl`. This is the
 *      primary source of truth. When the assistant spawns or restarts
 *      the gateway, the workspace config file is read so both processes
 *      agree on the same URL.
 *
 *   2. **Module-level state** (`getIngressPublicBaseUrl()`) — serves as a
 *      fallback for operational use (e.g. runtime tunnel updates). When
 *      tunnels start or stop, `setIngressPublicBaseUrl()` updates this
 *      value in-process.
 *
 * This chain ensures that:
 *   - The assistant's outbound callback URLs (Twilio webhooks, OAuth
 *     redirect URIs, etc.) match the gateway's inbound signature
 *     reconstruction URL.
 *   - Changing the URL in Settings immediately updates outbound callback
 *     registration, while the gateway can validate inbound Twilio signatures
 *     using forwarded public URL headers from tunnels/proxies.
 *
 * All public-facing ingress URL construction is centralized here.
 */

import { normalizePublicBaseUrl } from "@vellumai/service-contracts/ingress";

import { getIngressPublicBaseUrl } from "../config/env.js";

export interface IngressConfig {
  ingress?: {
    enabled?: boolean;
    publicBaseUrl?: string;
    twilioPublicBaseUrl?: string;
  };
}

function assertPublicIngressEnabled(config: IngressConfig): void {
  if (config.ingress?.enabled === false) {
    throw new Error(
      "Public ingress is disabled. Ask the assistant to enable it, or update it from the Settings page.",
    );
  }
}

/**
 * Resolve the canonical public base URL using the precedence chain
 * documented at the top of this module.
 *
 * When `ingress.enabled` is explicitly `false`, the public ingress is
 * considered disabled regardless of whether a URL is configured. This
 * allows the user to toggle ingress off without clearing the URL value.
 *
 * Throws if no source provides a non-empty value or if ingress is disabled.
 */
export function getPublicBaseUrl(config: IngressConfig): string {
  assertPublicIngressEnabled(config);

  const ingressValue = config.ingress?.publicBaseUrl;
  const normalizedIngressValue = normalizePublicBaseUrl(ingressValue);
  if (normalizedIngressValue) return normalizedIngressValue;

  const ingressEnvValue = getIngressPublicBaseUrl();
  const normalizedIngressEnvValue = normalizePublicBaseUrl(ingressEnvValue);
  if (normalizedIngressEnvValue) return normalizedIngressEnvValue;

  throw new Error(
    "No public base URL configured. Set ingress.publicBaseUrl in config.",
  );
}

export function getTwilioPublicBaseUrl(config: IngressConfig): string {
  assertPublicIngressEnabled(config);

  const ingressValue = config.ingress?.twilioPublicBaseUrl;
  const normalizedIngressValue = normalizePublicBaseUrl(ingressValue);
  if (normalizedIngressValue) return normalizedIngressValue;

  try {
    return getPublicBaseUrl(config);
  } catch (err) {
    if (
      err instanceof Error &&
      /No public base URL configured/.test(err.message)
    ) {
      throw new Error(
        "No Twilio public base URL configured. Set ingress.twilioPublicBaseUrl or ingress.publicBaseUrl in config.",
      );
    }
    throw err;
  }
}

/**
 * Build the Twilio voice webhook URL.
 *
 * When `callSessionId` is provided (outbound calls), it is included as a
 * query parameter so the gateway can correlate the webhook to an existing
 * session. When omitted (phone-number-level webhook configuration for
 * inbound calls), the URL is returned without the query parameter — the
 * gateway will create a new session for inbound calls.
 */
export function getTwilioVoiceWebhookUrl(
  config: IngressConfig,
  callSessionId?: string,
): string {
  const base = getTwilioPublicBaseUrl(config);
  if (callSessionId) {
    return `${base}/webhooks/twilio/voice?callSessionId=${callSessionId}`;
  }
  return `${base}/webhooks/twilio/voice`;
}

/**
 * Build the Twilio status callback URL.
 */
export function getTwilioStatusCallbackUrl(config: IngressConfig): string {
  const base = getTwilioPublicBaseUrl(config);
  return `${base}/webhooks/twilio/status`;
}

/**
 * Build the Twilio connect-action callback URL.
 */
export function getTwilioConnectActionUrl(config: IngressConfig): string {
  const base = getTwilioPublicBaseUrl(config);
  return `${base}/webhooks/twilio/connect-action`;
}

/**
 * Build the Twilio ConversationRelay WebSocket URL.
 * Converts http:// → ws:// and https:// → wss://.
 */
export function getTwilioRelayUrl(config: IngressConfig): string {
  const base = getTwilioPublicBaseUrl(config);
  const wsBase = base.replace(/^http(s?)/, "ws$1");
  return `${wsBase}/webhooks/twilio/relay`;
}

/**
 * Build the Twilio media-stream WebSocket URL.
 * Used for the `<Stream>` TwiML path when the STT provider requires
 * custom server-side transcription (e.g. OpenAI Whisper).
 * Converts http:// → ws:// and https:// → wss://.
 */
export function getTwilioMediaStreamUrl(config: IngressConfig): string {
  const base = getTwilioPublicBaseUrl(config);
  const wsBase = base.replace(/^http(s?)/, "ws$1");
  return `${wsBase}/webhooks/twilio/media-stream`;
}

/**
 * Build the OAuth callback URL.
 */
export function getOAuthCallbackUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/oauth/callback`;
}

/**
 * Build the Telegram webhook URL.
 */
export function getTelegramWebhookUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/telegram`;
}
