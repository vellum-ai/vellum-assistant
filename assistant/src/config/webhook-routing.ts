/**
 * Derivations answering "is this deployment set up to receive provider
 * webhooks?" from workspace config.
 *
 * Two consumers ask the same question for different reasons: the channel
 * readiness probes report it to the user, and the Telegram webhook health
 * sweep uses it to decide whether a missing/broken registration is even
 * meaningful. Both must agree — a probe that says "ingress is configured"
 * while the sweep says "no webhook expected" would be a silent divergence.
 */

import {
  normalizePublicBaseUrl,
  resolveTwilioPublicBaseUrl,
} from "@vellumai/service-contracts/twilio-ingress";

import { getIsPlatform } from "./env-registry.js";
import { loadRawConfig } from "./loader.js";

/**
 * True when a public ingress base URL is set and ingress is enabled.
 *
 * `ingress.enabled` is treated as opt-out: an unset flag with a base URL
 * present counts as enabled, matching how the URL alone has always been
 * enough to drive registration.
 */
export function hasIngressConfigured(
  options: { twilio?: boolean } = {},
): boolean {
  try {
    const raw = loadRawConfig();
    const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
    const effectiveBaseUrl = options.twilio
      ? (resolveTwilioPublicBaseUrl(ingress) ?? "")
      : (normalizePublicBaseUrl(ingress.publicBaseUrl) ?? "");
    const enabled =
      (ingress.enabled as boolean | undefined) ??
      (effectiveBaseUrl ? true : false);
    return enabled && effectiveBaseUrl.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * True when inbound webhooks have somewhere to land: either a self-hosted
 * public ingress URL, or — when `allowManagedCallbacks` is set and this is a
 * platform deployment — the platform's managed callback routes.
 */
export function hasWebhookRoutingConfigured(
  allowManagedCallbacks = false,
  options: { twilio?: boolean } = {},
): {
  configured: boolean;
  usesManagedCallbacks: boolean;
} {
  const ingressConfigured = hasIngressConfigured(options);
  if (ingressConfigured) {
    return { configured: true, usesManagedCallbacks: false };
  }

  const usesManagedCallbacks = allowManagedCallbacks && getIsPlatform();
  return {
    configured: usesManagedCallbacks,
    usesManagedCallbacks,
  };
}
