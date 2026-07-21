import { Sparkles } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";

/**
 * Header entry point for the in-chat onboarding UI prototype. Composed at
 * the route level into the top bar's right cluster, left of the
 * notifications bell. Activates the prototype's focused chat-only stage on
 * the current conversation; the floating prototype panel takes over from
 * there (this button hides along with the rest of the header controls).
 */
export function InChatOnboardingLaunchButton() {
  const startPrototype = useInChatOnboardingStore.use.startPrototype();

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
