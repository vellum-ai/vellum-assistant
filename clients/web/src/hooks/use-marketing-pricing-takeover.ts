/**
 * Read seam for the `marketing-pricing-takeover` client flag — the kill switch
 * over the marketing pricing funnel. One flag covers both halves: the rebuilt
 * `www.vellum.ai/pricing` takeover (served by the platform) and the
 * `/assistant/checkout?package=<slug>` deep link its package CTAs target.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * `"pending"` until the flag's real value is known. The flag defaults off, so
 * a surface that redirects when it reads `false` must treat the pre-hydration
 * window as undecided — bouncing there would strand a legitimately-enabled
 * funnel on every cold load.
 */
export type MarketingPricingTakeoverState = "pending" | "enabled" | "disabled";

export function useMarketingPricingTakeover(): MarketingPricingTakeoverState {
  const enabled = useClientFeatureFlagStore.use.marketingPricingTakeover();
  const hydrated = useClientFeatureFlagStore.use.hydrated();
  // Local and env overrides land synchronously at store init and win over the
  // server value, so an `enabled` read is decisive without waiting.
  if (enabled) {
    return "enabled";
  }
  return hydrated ? "disabled" : "pending";
}
