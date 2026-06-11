/**
 * Step state for the pre-chat onboarding flow with native persistence.
 *
 * Owns the `currentStep` state shared by both web and native flows.
 * On native, persists the step position to `sessionStorage` so an iOS
 * user who hot-reloads or returns after the OS reclaims memory resumes
 * where they left off. The storage key is user-scoped so a stale value
 * from user A doesn't bleed into user B.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import {
  restoreNativeStep,
  type PreChatStepId,
} from "@/domains/onboarding/prechat-steps";

export interface PreChatStepState {
  currentStep: PreChatStepId;
  setCurrentStep: (step: PreChatStepId) => void;
  /** Clear the persisted native step (called when the flow completes). */
  clearPersistedStep: () => void;
}

export function usePreChatStepState(
  userId: string | null,
  isNative: boolean,
): PreChatStepState {
  const screenStorageKey = userId ? `prechat_native_screen:${userId}` : null;

  const [currentStep, setCurrentStep] = useState<PreChatStepId>(() =>
    isNative ? "nativeName" : "name",
  );

  const persistNativeStep = useCallback(
    (value: PreChatStepId | null) => {
      if (!screenStorageKey) return;
      try {
        if (value === null) {
          sessionStorage.removeItem(screenStorageKey);
        } else {
          sessionStorage.setItem(screenStorageKey, value);
        }
      } catch {
        // sessionStorage can throw under privacy modes.
      }
    },
    [screenStorageKey],
  );

  // Restore persisted position when the active user changes (mount, or
  // logout→login). useLayoutEffect so the user never sees an incorrect
  // step momentarily.
  useLayoutEffect(() => {
    if (!screenStorageKey) return;
    try {
      const restored = restoreNativeStep(
        sessionStorage.getItem(screenStorageKey),
      );
      if (restored) setCurrentStep(restored);
    } catch {
      // sessionStorage can throw under privacy modes.
    }
  }, [screenStorageKey]);

  // Persist the native position as a pure consequence of the current step.
  useEffect(() => {
    if (!isNative) return;
    persistNativeStep(currentStep === "nativeVibe" ? "nativeVibe" : null);
  }, [isNative, currentStep, persistNativeStep]);

  const clearPersistedStep = useCallback(() => {
    persistNativeStep(null);
  }, [persistNativeStep]);

  return { currentStep, setCurrentStep, clearPersistedStep };
}
