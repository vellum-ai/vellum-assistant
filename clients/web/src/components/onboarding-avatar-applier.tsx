/**
 * Applies the avatar chosen during research-onboarding to the assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The chosen avatar traits aren't part of the pre-chat handoff context, so they
 * can't be set during hatch. This invisible component (mounted in `ChatLayout`)
 * watches for the staged `pendingAvatarTraits` and the active assistant id, then
 * persists the traits via `saveCharacterTraits`. Transient save failures keep
 * the staged value queued for a retry; the value clears only after a successful
 * save.
 */

import { useEffect, useRef, useState } from "react";

import { saveCharacterTraits } from "@/assistant/avatar-api";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const AVATAR_APPLY_RETRY_MS = 1_500;

export function OnboardingAvatarApplier() {
  const pendingAvatarTraits =
    useOnboardingFocusStore.use.pendingAvatarTraits();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const savingRef = useRef(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!pendingAvatarTraits || !assistantId || savingRef.current) return;
    savingRef.current = true;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const traits = pendingAvatarTraits;
    void saveCharacterTraits(assistantId, traits)
      .then((saved) => {
        if (!saved) throw new Error("Avatar traits were not saved");
        if (!cancelled) setPendingAvatarTraits(null);
      })
      .catch(() => {
        if (cancelled) return;
        retryTimer = setTimeout(() => {
          setRetryNonce((nonce) => nonce + 1);
        }, AVATAR_APPLY_RETRY_MS);
      })
      .finally(() => {
        if (!cancelled) savingRef.current = false;
      });

    return () => {
      cancelled = true;
      savingRef.current = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [pendingAvatarTraits, assistantId, retryNonce, setPendingAvatarTraits]);

  return null;
}
