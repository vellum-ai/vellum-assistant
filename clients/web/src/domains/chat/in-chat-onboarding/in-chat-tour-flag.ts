/**
 * Shared seam for the `in-chat-onboarding-tour` multivariate experiment
 * flag: the onboarding hand-off (auto-play on first workspace entry) and
 * the header replay button gate on the same arm. Targeted via
 * LaunchDarkly — planned 70% `tour` / 30% `control`.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const CONTROL_ARM = "control";

/** Current `in-chat-onboarding-tour` arm; "control" until flags hydrate. */
export function useInChatTourVariant(): string {
  return (
    useClientFeatureFlagStore.use.stringFlags().inChatOnboardingTour ??
    CONTROL_ARM
  );
}

/** Non-reactive read of the arm, for one-shot effects. */
export function readInChatTourVariant(): string {
  return (
    useClientFeatureFlagStore.getState().stringFlags.inChatOnboardingTour ??
    CONTROL_ARM
  );
}

/** Whether the arm plays the tour. */
export function isInChatTourOn(variant: string): boolean {
  return variant === "tour";
}
