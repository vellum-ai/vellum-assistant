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
 * Platform-hosted assistants use `getPlatformPublicCallbackBase()` for
 * registration-gated callback surfaces (A2A, ingress config display) but
 * NOT as a generic `getPublicBaseUrl()` fallback — the callback prefix
 * only routes paths that are registered in `AssistantCallbackRoute`.
 *
 * All public-facing ingress URL construction is centralized here.
 */

import {
  buildTwilioConnectActionUrl,
  buildTwilioMediaStreamUrl,
  buildTwilioRelayUrl,
  buildTwilioStatusWebhookUrl,
  buildTwilioVoiceWebhookUrl,
  normalizePublicBaseUrl,
} from "@vellumai/service-contracts/twilio-ingress";

import {
  getIngressPublicBaseUrl,
  getPlatformAssistantId,
  getPlatformBaseUrl,
} from "../config/env.js";
import { getIsPlatform } from "../config/env-registry.js";

export interface IngressConfig {
  ingress?: {
    enabled?: boolean;
    publicBaseUrl?: string;
  };
}

/**
 * Derive the platform callback base URL for platform-hosted assistants.
 *
 * Returns `https://<platformBase>/v1/gateway/callbacks/<assistantId>` when
 * `IS_PLATFORM=true` and both the platform base URL and assistant ID are
 * available. The `/v1` prefix matches the Django URL pattern at
 * `django/config/api_router.py` (`gateway/callbacks/<path:callback_path>/`).
 *
 * Returns `undefined` when not in platform mode or when the required
 * identifiers are missing.
 */
export function getPlatformPublicCallbackBase(): string | undefined {
  if (!getIsPlatform()) return undefined;

  const platformBase = getPlatformBaseUrl().replace(/\/+$/, "");
  const assistantId = getPlatformAssistantId();
  if (!platformBase || !assistantId) return undefined;

  return `${platformBase}/v1/gateway/callbacks/${assistantId}`;
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
  return buildTwilioVoiceWebhookUrl(getPublicBaseUrl(config), callSessionId);
}

/**
 * Build the Twilio status callback URL.
 */
export function getTwilioStatusCallbackUrl(config: IngressConfig): string {
  return buildTwilioStatusWebhookUrl(getPublicBaseUrl(config));
}

/**
 * Build the Twilio connect-action callback URL.
 */
export function getTwilioConnectActionUrl(config: IngressConfig): string {
  return buildTwilioConnectActionUrl(getPublicBaseUrl(config));
}

/**
 * Build the Twilio ConversationRelay WebSocket URL.
 * Converts http:// → ws:// and https:// → wss://.
 */
export function getTwilioRelayUrl(config: IngressConfig): string {
  return buildTwilioRelayUrl(getPublicBaseUrl(config));
}

/**
 * Build the Twilio media-stream WebSocket URL.
 * Used for the `<Stream>` TwiML path when the STT provider requires
 * custom server-side transcription (e.g. OpenAI Whisper).
 * Converts http:// → ws:// and https:// → wss://.
 */
export function getTwilioMediaStreamUrl(config: IngressConfig): string {
  return buildTwilioMediaStreamUrl(getPublicBaseUrl(config));
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
