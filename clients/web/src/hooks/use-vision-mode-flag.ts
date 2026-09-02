/**
 * Shared seam for the `vision-mode` string feature flag, which gates the Eyes
 * camera surface in the web composer. String-valued so future arms can be added
 * as new values rather than as a second boolean.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/** Current `vision-mode` arm; "off" until flags hydrate. */
export function useVisionModeVariant(): string {
  return useClientFeatureFlagStore.use.stringFlags().visionMode ?? "off";
}

/** Whether the arm enables the camera surface. */
export function isVisionModeOn(variant: string): boolean {
  return variant === "on";
}
