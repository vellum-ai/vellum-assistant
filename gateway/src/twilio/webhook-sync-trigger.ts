import {
  TWILIO_PUBLIC_BASE_URL_FIELD,
  TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD,
} from "@vellumai/service-contracts/twilio-ingress";

import type { ConfigChangeEvent } from "../config-file-watcher.js";

const PUBLIC_BASE_URL_FIELD = "publicBaseUrl";
const TWILIO_PHONE_NUMBER_FIELD = "phoneNumber";
const TWILIO_ACCOUNT_SID_FIELD = "accountSid";

export function isOnlyVelayTwilioIngressChange(
  event: ConfigChangeEvent,
): boolean {
  if (event.changedKeys.size !== 1 || !event.changedKeys.has("ingress")) {
    return false;
  }

  const ingressFields = event.changedFields.get("ingress");
  if (!ingressFields || ingressFields.size === 0) {
    return false;
  }

  return [...ingressFields].every(
    (field) =>
      field === TWILIO_PUBLIC_BASE_URL_FIELD ||
      field === TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD,
  );
}

export function shouldSyncTwilioPhoneWebhooksAfterConfigChange(
  event: ConfigChangeEvent,
): boolean {
  if (event.changedKeys.has("ingress")) {
    const ingressFields = event.changedFields.get("ingress");
    if (
      ingressFields?.has(TWILIO_PUBLIC_BASE_URL_FIELD) === true ||
      ingressFields?.has(PUBLIC_BASE_URL_FIELD) === true
    ) {
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
