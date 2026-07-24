/**
 * Shared seam for the `in-chat-onboarding-tour` flag, read at the
 * onboarding hand-off (auto-play on first workspace entry). Shipped on:
 * the default arm is `tour`; `control` remains as a kill-switch arm.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const DEFAULT_ARM = "tour";

/** Non-reactive read of the arm, for one-shot effects. */
export function readInChatTourVariant(): string {
  return (
    useClientFeatureFlagStore.getState().stringFlags.inChatOnboardingTour ??
    DEFAULT_ARM
  );
}

/** Whether the arm plays the tour. */
export function isInChatTourOn(variant: string): boolean {
  return variant === "tour";
}
