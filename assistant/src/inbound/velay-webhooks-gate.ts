import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";

const VELAY_WEBHOOKS_FLAG_KEY = "velay-webhooks" as const;

/**
 * Whether platform pods resolve webhook callback URLs from the
 * Velay-published ingress URL instead of registering platform callback
 * routes.
 *
 * Gates the platform-pod tier in all three webhook resolution sites
 * (`resolveCallbackUrl`, `hasWebhookRoutingConfigured`,
 * `handleWebhooksRegister`), which must agree tier for tier. Off means the
 * pre-Velay behavior: platform pods always register with the platform
 * gateway. On means ingress-first with platform registration as the
 * fallback, so a pod whose tunnel has not published a URL yet keeps
 * working either way.
 */
export function isVelayWebhooksEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(VELAY_WEBHOOKS_FLAG_KEY);
}
