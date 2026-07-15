/**
 * Shared seam for the `proactive-tips` string feature flag: the sidebar tip
 * card (`useTipCard`) and the Settings "Show tips" toggle gate on the same
 * arm, and the raw variant string is stamped on tip telemetry.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/** Current `proactive-tips` arm; "off" until flags hydrate. */
export function useProactiveTipsVariant(): string {
  return useClientFeatureFlagStore.use.stringFlags().proactiveTips ?? "off";
}

/** Whether the arm enables the tips surface. */
export function isProactiveTipsOn(variant: string): boolean {
  return variant === "on";
}
