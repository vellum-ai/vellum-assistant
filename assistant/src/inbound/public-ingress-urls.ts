/**
 * Centralized URL builders for all public-facing ingress endpoints.
 *
 * ## Source-of-truth precedence
 *
 * The canonical public base URL is resolved through a two-level chain:
 *
 *   1. **User Settings** (`config.ingress.publicBaseUrl`) — set via the
 *      Settings UI or `config set ingress.publicBaseUrl`. This is the
 *      primary source of truth. When the assistant spawns or restarts
 *      the gateway, this value is forwarded as the `INGRESS_PUBLIC_BASE_URL`
 *      environment variable so both processes agree on the same URL.
 *
 *   2. **Environment variable** (`INGRESS_PUBLIC_BASE_URL`) — serves as a
 *      fallback for operational use (e.g. direct gateway-only deployments
 *      without the assistant, or CI overrides). When the assistant is
 *      managing the gateway, the env var is set automatically from (1).
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

export interface IngressConfig {
  ingress?: { publicBaseUrl?: string };
}

/**
 * Trim whitespace and strip trailing slashes from a URL string.
 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolve the canonical public base URL using the precedence chain
 * documented at the top of this module.
 *
 * Throws if no source provides a non-empty value.
 */
export function getPublicBaseUrl(config: IngressConfig): string {
  const ingressValue = config.ingress?.publicBaseUrl;
  if (ingressValue) {
    const normalized = normalizeUrl(ingressValue);
    if (normalized) return normalized;
  }

  const ingressEnvValue = process.env.INGRESS_PUBLIC_BASE_URL;
  if (ingressEnvValue) {
    const normalized = normalizeUrl(ingressEnvValue);
    if (normalized) return normalized;
  }

  throw new Error(
    'No public base URL configured. Set ingress.publicBaseUrl in config or INGRESS_PUBLIC_BASE_URL env var.',
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

/**
 * Build the Telegram webhook URL.
 */
export function getTelegramWebhookUrl(config: IngressConfig): string {
  const base = getPublicBaseUrl(config);
  return `${base}/webhooks/telegram`;
}
