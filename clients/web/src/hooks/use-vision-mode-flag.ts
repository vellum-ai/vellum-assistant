/**
 * Shared seam for the vision-mode string feature flags, which gate the Eyes
 * camera surfaces. String-valued so future arms can be added as new values
 * rather than as a second boolean.
 *
 * Two flags, one per surface. `vision-mode` is the feature: on its own it
 * reaches the voice room's sight features. `vision-mode-chat` adds the
 * composer's camera on top of it, so the in-chat surface can be turned off
 * without taking the voice room's with it.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/** Current `vision-mode` arm; "off" until flags hydrate. */
export function useVisionModeVariant(): string {
  return useClientFeatureFlagStore.use.stringFlags().visionMode ?? "off";
}

/** Current `vision-mode-chat` arm; "off" until flags hydrate. */
export function useVisionModeChatVariant(): string {
  return useClientFeatureFlagStore.use.stringFlags().visionModeChat ?? "off";
}

/** Whether the arm enables the camera surface. */
export function isVisionModeOn(variant: string): boolean {
  return variant === "on";
}
