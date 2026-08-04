/**
 * Applies the avatar chosen during research-onboarding to the assistant: both
 * halves of it, the face and the voice that face was auditioned in.
 *
 * SPIKE: research-onboarding flow.
 *
 * Neither is part of the pre-chat handoff context, so neither can be set during
 * hatch. This invisible component (mounted in `ChatLayout`) watches for the
 * staged `pendingAvatarTraits` / `pendingAvatarVoice` and the active assistant
 * id, then persists the traits via `saveCharacterTraits` and the voice via
 * `config_patch`. Transient save failures retry with bounded backoff; the staged
 * values clear after a successful save or after the retry budget is exhausted.
 *
 * The two are applied as ONE handoff, under one retry budget, because they are
 * one pick: an assistant wearing the face it was given but speaking in a voice
 * the user never heard is worse than neither landing.
 */

import { useEffect, useRef, useState } from "react";

import { saveCharacterTraits } from "@/assistant/avatar-api";
import { configPatch } from "@/generated/daemon/sdk.gen";
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

/**
 * Persist the avatar's voice to the assistant's managed-TTS config. Onboarding
 * assistants are managed, so the voice lives on the `vellum` provider block,
 * the same field every voice picker writes.
 *
 * A null voice is a no-op success: the catalog never loaded, so there is
 * nothing to say beyond the platform default the assistant already has.
 */
async function saveAvatarVoice(
  assistantId: string,
  model: string | null,
): Promise<void> {
  if (!model) {
    return;
  }
  const { response } = await configPatch({
    path: { assistant_id: assistantId },
    body: { services: { tts: { providers: { vellum: { model } } } } },
    throwOnError: false,
  });
  if (!response?.ok) {
    throw new Error("Avatar voice was not saved");
  }
}

export function OnboardingAvatarApplier() {
  const pendingAvatarTraits = useOnboardingFocusStore.use.pendingAvatarTraits();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  const setPendingAvatarVoice =
    useOnboardingFocusStore.use.setPendingAvatarVoice();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const savingRef = useRef(false);
  const failedAttemptsRef = useRef(0);
  const currentHandoffRef = useRef<{
    assistantId: string;
    traits: CharacterTraits;
  } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!pendingAvatarTraits || !assistantId || savingRef.current) {
      return;
    }
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
    // The voice rides along with the traits rather than driving the effect
    // itself: both are staged in the same turn, so re-running on the voice
    // would only re-fire the handoff the traits already own. Read at apply
    // time so a retry always carries the current pick.
    const voice = useOnboardingFocusStore.getState().pendingAvatarVoice;
    void saveCharacterTraits(assistantId, traits)
      .then(async (saved) => {
        if (!saved) {
          throw new Error("Avatar traits were not saved");
        }
        await saveAvatarVoice(assistantId, voice);
        if (!cancelled) {
          currentHandoffRef.current = null;
          failedAttemptsRef.current = 0;
          setPendingAvatarTraits(null);
          setPendingAvatarVoice(null);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        const failedAttempts = failedAttemptsRef.current + 1;
        failedAttemptsRef.current = failedAttempts;
        if (shouldDropAvatarHandoff(failedAttempts)) {
          currentHandoffRef.current = null;
          setPendingAvatarTraits(null);
          setPendingAvatarVoice(null);
          return;
        }
        retryTimer = setTimeout(() => {
          setRetryNonce((nonce) => nonce + 1);
        }, getAvatarApplyRetryDelayMs(failedAttempts));
      })
      .finally(() => {
        if (!cancelled) {
          savingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
      savingRef.current = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [
    pendingAvatarTraits,
    assistantId,
    retryNonce,
    setPendingAvatarTraits,
    setPendingAvatarVoice,
  ]);

  return null;
}
