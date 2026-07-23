import { Sparkles } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";

import { isInChatTourOn, useInChatTourVariant } from "./in-chat-tour-flag";
import { emitInChatTourStarted } from "./tour-telemetry";

/**
 * Header entry point for the in-chat onboarding UI prototype — a stand-in
 * for the hand-off from research onboarding, kept for easy testing.
 * Composed at the route level into the top bar's right cluster, left of
 * the notifications bell. Plays the tour immediately; pressing it again
 * afterwards replays from the top.
 *
 * Gated on the `in-chat-onboarding-tour` experiment's `tour` arm
 * (default `control`), same seam as the post-onboarding auto-play — and
 * desktop-only, like the tour itself: hidden on phone-width viewports and
 * in the native shell, where the takeover's sidebar/composer choreography
 * doesn't apply.
 */
export function InChatOnboardingLaunchButton() {
  const startPrototype = useInChatOnboardingStore.use.startPrototype();
  const variant = useInChatTourVariant();
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();

  if (isMobile || isNative || !isInChatTourOn(variant)) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      iconOnly={<Sparkles />}
      aria-label="In-chat onboarding (prototype)"
      tooltip="In-chat onboarding (prototype)"
      onClick={() => {
        startPrototype();
        emitInChatTourStarted("replay");
      }}
    />
  );
}
