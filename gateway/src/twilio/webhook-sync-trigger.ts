import type { ConfigChangeEvent } from "../config-file-watcher.js";

const PUBLIC_BASE_URL_FIELD = "publicBaseUrl";
const PUBLIC_BASE_URL_MANAGED_BY_FIELD = "publicBaseUrlManagedBy";
const TWILIO_PHONE_NUMBER_FIELD = "phoneNumber";
const TWILIO_ACCOUNT_SID_FIELD = "accountSid";

/**
 * Returns true when the only config change is a Velay-managed publicBaseUrl
 * update. Callers use this to skip side effects that shouldn't fire for
 * Velay-only ingress updates (e.g. Telegram webhook re-registration).
 */
export function isOnlyVelayPublicBaseUrlChange(
  event: ConfigChangeEvent,
): boolean {
  if (event.changedKeys.size !== 1 || !event.changedKeys.has("ingress")) {
    return false;
  }

  const ingressFields = event.changedFields.get("ingress");
  if (!ingressFields || ingressFields.size === 0) {
    return false;
  }

  // A Velay-managed update always touches publicBaseUrlManagedBy. If only
  // publicBaseUrl changed (without the manager marker), treat it as a
  // user-initiated change that should trigger downstream side effects.
  if (!ingressFields.has(PUBLIC_BASE_URL_MANAGED_BY_FIELD)) {
    return false;
  }

  return [...ingressFields].every(
    (field) =>
      field === PUBLIC_BASE_URL_FIELD ||
      field === PUBLIC_BASE_URL_MANAGED_BY_FIELD,
  );
}

export function shouldSyncTwilioPhoneWebhooksAfterConfigChange(
  event: ConfigChangeEvent,
): boolean {
  if (event.changedKeys.has("ingress")) {
    const ingressFields = event.changedFields.get("ingress");
    if (ingressFields?.has(PUBLIC_BASE_URL_FIELD) === true) {
      return true;
    }
  }

  if (!event.changedKeys.has("twilio")) {
    return false;
  }

  const twilioFields = event.changedFields.get("twilio");
  return (
    twilioFields?.has(TWILIO_PHONE_NUMBER_FIELD) === true ||
    twilioFields?.has(TWILIO_ACCOUNT_SID_FIELD) === true
  );
}
