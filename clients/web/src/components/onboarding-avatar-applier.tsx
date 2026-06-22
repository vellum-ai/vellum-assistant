/**
 * Applies the avatar chosen during research-onboarding to the assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The chosen avatar traits aren't part of the pre-chat handoff context, so they
 * can't be set during hatch. This invisible component (mounted in `ChatLayout`)
 * watches for the staged `pendingAvatarTraits` and the active assistant id, then
 * persists the traits via `saveCharacterTraits` exactly once — the moment the
 * freshly-hatched assistant becomes reachable — and clears the staged value.
 */

import { useEffect, useRef } from "react";

import { saveCharacterTraits } from "@/assistant/avatar-api";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function OnboardingAvatarApplier() {
  const pendingAvatarTraits =
    useOnboardingFocusStore.use.pendingAvatarTraits();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // Guards against a double-apply if this re-renders before the clear lands.
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!pendingAvatarTraits || !assistantId || appliedRef.current) return;
    appliedRef.current = true;
    const traits = pendingAvatarTraits;
    void saveCharacterTraits(assistantId, traits).finally(() => {
      setPendingAvatarTraits(null);
    });
  }, [pendingAvatarTraits, assistantId, setPendingAvatarTraits]);

  return null;
}
