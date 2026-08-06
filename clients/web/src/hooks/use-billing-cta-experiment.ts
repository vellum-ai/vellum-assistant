/**
 * Read seam for the `experiment-billing-cta-2026-07-23` string flag: the credit
 * paywall gates on this arm to decide whether FREE users see a single Upgrade
 * CTA (View Plans takeover) instead of the default Add Credits CTA.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/** Current `experiment-billing-cta-2026-07-23` arm; "control" until flags hydrate. */
export function useBillingCtaExperimentArm(): string {
  return (
    useClientFeatureFlagStore.use.stringFlags().experimentBillingCta20260723 ??
    "control"
  );
}

/** Whether the arm enables the free-user Upgrade CTA on the credit paywall. */
export function isBillingCtaUpgradeArm(arm: string): boolean {
  return arm === "upgrade-cta";
}
