import { Sparkles } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";

/**
 * Header entry point for the in-chat onboarding UI prototype — a stand-in
 * for the hand-off from research onboarding, kept for easy testing.
 * Composed at the route level into the top bar's right cluster, left of
 * the notifications bell. Plays the tour immediately; pressing it again
 * afterwards replays from the top.
 *
 * Gated on the `in-chat-onboarding-tour` client flag (off by default) so
 * the tour can bake internally before anyone outside Vellum sees it.
 */
export function InChatOnboardingLaunchButton() {
  const startPrototype = useInChatOnboardingStore.use.startPrototype();
  const tourEnabled = useClientFeatureFlagStore.use.inChatOnboardingTour();

  if (!tourEnabled) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      iconOnly={<Sparkles />}
      aria-label="In-chat onboarding (prototype)"
      tooltip="In-chat onboarding (prototype)"
      onClick={startPrototype}
    />
  );
}
