export const TWILIO_PUBLIC_BASE_URL_FIELD = "twilioPublicBaseUrl";
export const TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD =
  "twilioPublicBaseUrlManagedBy";
export const VELAY_TWILIO_PUBLIC_BASE_URL_MANAGER = "velay";
export const TWILIO_VOICE_WEBHOOK_PATH = "/webhooks/twilio/voice";
export const TWILIO_STATUS_WEBHOOK_PATH = "/webhooks/twilio/status";
export const TWILIO_CONNECT_ACTION_WEBHOOK_PATH =
  "/webhooks/twilio/connect-action";
export const TWILIO_RELAY_WEBHOOK_PATH = "/webhooks/twilio/relay";
export const TWILIO_MEDIA_STREAM_WEBHOOK_PATH = "/webhooks/twilio/media-stream";

export { normalizePublicBaseUrl } from "./ingress.js";
