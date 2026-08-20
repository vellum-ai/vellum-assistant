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

import { resolvePlatformCallbackRegistrationContext } from "../inbound/platform-callback-registration.js";
import { isPublicIngressDisabled } from "../inbound/public-ingress-urls.js";
import { getIsPlatform } from "./env-registry.js";
import { getConfig, loadRawConfig } from "./loader.js";

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
 * True when the user has explicitly switched public ingress off.
 *
 * Reads the validated config rather than the raw file so the check matches
 * what `getPublicBaseUrl` enforces. A config that fails to load is treated as
 * "not explicitly disabled": absence of a decision is not an opt-out.
 */
function isIngressExplicitlyDisabled(): boolean {
  try {
    return isPublicIngressDisabled(getConfig());
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
 *   1. **Platform pods** (`IS_PLATFORM`) always use managed callbacks.
 *   2. **A configured public ingress wins** for everyone else.
 *   3. **Platform-connected assistants with no ingress** fall back to managed
 *      callbacks. Connectivity is decided by credentials (platform base URL +
 *      assistant ID + assistant API key), not by `IS_PLATFORM`, which is only
 *      ever true on a platform pod.
 *   4. Otherwise nothing is configured.
 *
 * Ingress deliberately precedes the platform fallback: any logged-in local
 * assistant holds platform credentials for the LLM proxy, so treating
 * credential presence as "managed" would misreport an explicitly configured
 * self-hosted webhook as platform-routed. An explicit `ingress.enabled: false`
 * is a decision not to accept inbound webhooks at all and blocks the fallback.
 *
 * `allowManagedCallbacks` gates both platform tiers: channels that can only be
 * served by a self-hosted ingress pass `false` and never see them.
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
  if (allowManagedCallbacks && getIsPlatform()) {
    return { configured: true, usesManagedCallbacks: true };
  }

  if (hasIngressConfigured(options)) {
    return { configured: true, usesManagedCallbacks: false };
  }

  if (!allowManagedCallbacks || isIngressExplicitlyDisabled()) {
    return { configured: false, usesManagedCallbacks: false };
  }

  const { enabled } = await resolvePlatformCallbackRegistrationContext();
  return { configured: enabled, usesManagedCallbacks: enabled };
}
