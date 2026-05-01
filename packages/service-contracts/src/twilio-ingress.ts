import { normalizePublicBaseUrl } from "./ingress.js";

export const TWILIO_VOICE_WEBHOOK_PATH = "/webhooks/twilio/voice";
export const TWILIO_STATUS_WEBHOOK_PATH = "/webhooks/twilio/status";
export const TWILIO_CONNECT_ACTION_WEBHOOK_PATH =
  "/webhooks/twilio/connect-action";
export const TWILIO_RELAY_WEBHOOK_PATH = "/webhooks/twilio/relay";
export const TWILIO_MEDIA_STREAM_WEBHOOK_PATH = "/webhooks/twilio/media-stream";

export { normalizePublicBaseUrl } from "./ingress.js";

export type TwilioPhoneNumberWebhookUrls = {
  statusCallbackUrl: string;
  voiceUrl: string;
};

export function resolveTwilioPublicBaseUrl(
  ingress: { publicBaseUrl?: unknown } | undefined,
  fallbackPublicBaseUrl?: unknown,
): string | undefined {
  const publicBaseUrl = normalizePublicBaseUrl(ingress?.publicBaseUrl);
  if (publicBaseUrl) return publicBaseUrl;

  return normalizePublicBaseUrl(fallbackPublicBaseUrl);
}

export function buildTwilioVoiceWebhookUrl(
  baseUrl: string,
  callSessionId?: string,
): string {
  if (callSessionId) {
    return `${baseUrl}${TWILIO_VOICE_WEBHOOK_PATH}?callSessionId=${callSessionId}`;
  }
  return `${baseUrl}${TWILIO_VOICE_WEBHOOK_PATH}`;
}

export function buildTwilioStatusWebhookUrl(baseUrl: string): string {
  return `${baseUrl}${TWILIO_STATUS_WEBHOOK_PATH}`;
}

export function buildTwilioConnectActionUrl(baseUrl: string): string {
  return `${baseUrl}${TWILIO_CONNECT_ACTION_WEBHOOK_PATH}`;
}

export function buildTwilioRelayUrl(baseUrl: string): string {
  return `${toTwilioWebSocketBaseUrl(baseUrl)}${TWILIO_RELAY_WEBHOOK_PATH}`;
}

export function buildTwilioMediaStreamUrl(baseUrl: string): string {
  return `${toTwilioWebSocketBaseUrl(baseUrl)}${TWILIO_MEDIA_STREAM_WEBHOOK_PATH}`;
}

export function buildTwilioPhoneNumberWebhookUrls(
  baseUrl: string,
): TwilioPhoneNumberWebhookUrls {
  return {
    statusCallbackUrl: buildTwilioStatusWebhookUrl(baseUrl),
    voiceUrl: buildTwilioVoiceWebhookUrl(baseUrl),
  };
}

function toTwilioWebSocketBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/^http(s?)/, "ws$1");
}
