/**
 * Applies the avatar chosen during research-onboarding to the assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The chosen avatar traits aren't part of the pre-chat handoff context, so they
 * can't be set during hatch. This invisible component (mounted in `ChatLayout`)
 * watches for the staged `pendingAvatarTraits` and the active assistant id, then
 * persists the traits via `saveCharacterTraits`. Transient save failures retry
 * with bounded backoff; the staged value clears after a successful save or after
 * the retry budget is exhausted.
 */

import { useEffect, useRef, useState } from "react";

import { saveCharacterTraits } from "@/assistant/avatar-api";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterTraits } from "@/types/avatar";

const AVATAR_APPLY_INITIAL_RETRY_MS = 1_500;
const AVATAR_APPLY_MAX_RETRY_MS = 15_000;
const AVATAR_APPLY_MAX_ATTEMPTS = 6;

export function getAvatarApplyRetryDelayMs(failedAttempts: number): number {
  return Math.min(
    AVATAR_APPLY_INITIAL_RETRY_MS * 2 ** Math.max(0, failedAttempts - 1),
    AVATAR_APPLY_MAX_RETRY_MS,
  );
}

export function shouldDropAvatarHandoff(failedAttempts: number): boolean {
  return failedAttempts >= AVATAR_APPLY_MAX_ATTEMPTS;
}

export function OnboardingAvatarApplier() {
  const pendingAvatarTraits =
    useOnboardingFocusStore.use.pendingAvatarTraits();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const savingRef = useRef(false);
  const failedAttemptsRef = useRef(0);
  const currentHandoffRef = useRef<{
    assistantId: string;
    traits: CharacterTraits;
  } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!pendingAvatarTraits || !assistantId || savingRef.current) return;
    const currentHandoff = currentHandoffRef.current;
    if (
      currentHandoff?.assistantId !== assistantId ||
      currentHandoff.traits !== pendingAvatarTraits
    ) {
      currentHandoffRef.current = {
        assistantId,
        traits: pendingAvatarTraits,
      };
      failedAttemptsRef.current = 0;
    }
    savingRef.current = true;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const traits = pendingAvatarTraits;
    void saveCharacterTraits(assistantId, traits)
      .then((saved) => {
        if (!saved) throw new Error("Avatar traits were not saved");
        if (!cancelled) {
          currentHandoffRef.current = null;
          failedAttemptsRef.current = 0;
          setPendingAvatarTraits(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        const failedAttempts = failedAttemptsRef.current + 1;
        failedAttemptsRef.current = failedAttempts;
        if (shouldDropAvatarHandoff(failedAttempts)) {
          currentHandoffRef.current = null;
          setPendingAvatarTraits(null);
          return;
        }
        retryTimer = setTimeout(() => {
          setRetryNonce((nonce) => nonce + 1);
        }, getAvatarApplyRetryDelayMs(failedAttempts));
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
