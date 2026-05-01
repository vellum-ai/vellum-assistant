import {
  TWILIO_PUBLIC_BASE_URL_FIELD,
  TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD,
} from "@vellumai/service-contracts/twilio-ingress";

import type { ConfigChangeEvent } from "../config-file-watcher.js";

const PUBLIC_BASE_URL_FIELD = "publicBaseUrl";

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
  if (!event.changedKeys.has("ingress")) {
    return false;
  }

  const ingressFields = event.changedFields.get("ingress");
  return (
    ingressFields?.has(TWILIO_PUBLIC_BASE_URL_FIELD) === true ||
    ingressFields?.has(PUBLIC_BASE_URL_FIELD) === true
  );
}
