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

import { isVelayWebhooksEnabled } from "../inbound/velay-webhooks-gate.js";
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
 * True when inbound webhooks have somewhere to land.
 *
 * Mirrors the resolution order `handleWebhooksRegister` uses in
 * `runtime/routes/webhook-routes.ts`, because the two must agree: a probe that
 * reports "no ingress" while `webhooks register` hands back a working callback
 * URL hides a broken registration instead of surfacing it.
 *
 *   1. **Platform pods** (`IS_PLATFORM`) with the `velay-webhooks` flag off
 *      always use managed callbacks. With the flag on, a configured ingress
 *      (the Velay-published URL) wins, and managed callbacks remain the
 *      fallback — including when ingress is explicitly disabled, matching
 *      `resolveCallbackUrl`'s pod behavior.
 *   2. **A configured public ingress wins** for everyone else.
 *   3. Self-hosted assistants without ingress are not configured, regardless
 *      of platform credentials. Platform registration requires their address.
 *
 * `allowManagedCallbacks` gates the platform-pod tier. Channels served only
 * through self-hosted ingress pass `false`.
 *
 * The gateway's Telegram webhook reconciler implements this same resolution
 * order when deciding what URL to hand Telegram's setWebhook
 * (`resolveExpectedTelegramWebhookUrl` in
 * `gateway/src/telegram/webhook-manager.ts`). The two must stay in agreement:
 * a tier this derivation reports as configured but the reconciler declines
 * leaves Telegram setup reporting success while no webhook is ever
 * registered. Change the tiers in both places or not at all.
 */
export async function hasWebhookRoutingConfigured(
  allowManagedCallbacks = false,
  options: { twilio?: boolean } = {},
): Promise<{
  configured: boolean;
  usesManagedCallbacks: boolean;
}> {
  const platformManaged = allowManagedCallbacks && getIsPlatform();
  if (platformManaged && !isVelayWebhooksEnabled()) {
    return { configured: true, usesManagedCallbacks: true };
  }

  if (hasIngressConfigured(options)) {
    return { configured: true, usesManagedCallbacks: false };
  }

  if (platformManaged) {
    return { configured: true, usesManagedCallbacks: true };
  }

  return { configured: false, usesManagedCallbacks: false };
}
