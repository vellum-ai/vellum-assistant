/**
 * Onboarding preference public API.
 *
 * Boolean preferences (`shareAnalytics`, `shareDiagnostics`, `tosAccepted`,
 * `aiDataConsent`, `completed`) are owned by `useOnboardingStore` — a
 * Zustand store with a custom per-key `persist` adapter that maps each
 * field to its existing localStorage key. This file exposes the hook +
 * non-React shim around the store, plus the non-store helpers for the
 * onboarding-only keys that don't fit the boolean store shape
 * (`onboarding.selectedVersion`, `onboarding.lastUserId`).
 *
 * Storage keys are documented in `onboarding-store.ts`. The privacy
 * settings page and the Sentry consent gate read `device:share_*`
 * directly — that contract is preserved by the per-key adapter.
 */
import { useCallback } from "react";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { getDeviceSetting } from "@/utils/device-settings";
import {
  KEY_TOS_ACCEPTED,
  KEY_AI_DATA_CONSENT,
  KEY_COMPLETED,
} from "@/utils/onboarding-cleanup";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

// ---------------------------------------------------------------------------
// Storage keys (non-boolean — boolean keys live in onboarding-store.ts)
// ---------------------------------------------------------------------------

/**
 * Onboarding-only, nonprod-only: pinned release version for the hatch.
 * Written by the privacy screen's dev-tools version picker, read by the
 * hatching screen and forwarded to `hatchAssistant({ version })`. Empty
 * string / absent means "latest" (the normal managed default).
 */
const KEY_SELECTED_VERSION = "vellum:onboarding:selectedVersion";

// ---------------------------------------------------------------------------
// Public hooks — thin wrappers around the Zustand store
// ---------------------------------------------------------------------------

/**
 * Share anonymous product analytics. Defaults to `true`.
 * Backed by the SAME localStorage key as `/settings/privacy` so onboarding
 * and settings are a single source of truth.
 */
export function useShareAnalytics(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.shareAnalytics();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setShareAnalytics(next);
  }, []);
  return [value, setter];
}

/**
 * Share crash reports and diagnostics. Defaults to `true`.
 * Backed by the SAME localStorage key as `/settings/privacy`.
 */
export function useShareDiagnostics(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.shareDiagnostics();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setShareDiagnostics(next);
  }, []);
  return [value, setter];
}

/** Whether the user accepted Terms of Service during onboarding. Defaults to `false`. */
export function useTosAccepted(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.tosAccepted();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setTosAccepted(next);
  }, []);
  return [value, setter];
}

/**
 * Whether the user has explicitly acknowledged that conversation data is
 * sent to third-party AI providers. Defaults to `false`. Tracked separately
 * from `useTosAccepted` so the consent surface remains specific (Apple
 * Guideline 5.1.2(i)).
 */
export function useAiDataConsent(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.aiDataConsent();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setAiDataConsent(next);
  }, []);
  return [value, setter];
}

/** Whether the user completed the onboarding flow. Defaults to `false`. */
export function useOnboardingCompleted(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.completed();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setOnboardingCompleted(next);
  }, []);
  return [value, setter];
}

// ---------------------------------------------------------------------------
// Non-hook readers (for gates/guards outside React render)
// ---------------------------------------------------------------------------

/** SSR-safe, non-hook read of the onboarding completion flag. */
export function readOnboardingCompleted(): boolean {
  return useOnboardingStore.getState().completed;
}

/** SSR-safe, non-hook clear of the completion flag. */
export function clearOnboardingCompleted(): void {
  useOnboardingStore.getState().setOnboardingCompleted(false);
}

/**
 * SSR-safe, non-hook read of the TOS-accepted flag. Used by
 * `/onboarding/hatching` to refuse to provision an assistant if the user
 * navigated directly to that URL without ever seeing the privacy screen.
 */
export function readTosAccepted(): boolean {
  return useOnboardingStore.getState().tosAccepted;
}

/**
 * SSR-safe, non-hook read of the AI data sharing consent flag. Used
 * alongside `readTosAccepted()` by the hatching gate so a user who
 * somehow has only one of the two acknowledgments persisted (storage
 * race, partial restore from a sync mechanism) is bounced back through
 * the privacy screen rather than allowed to provision an assistant
 * without explicit AI consent.
 */
export function readAiDataConsent(): boolean {
  return useOnboardingStore.getState().aiDataConsent;
}

/** SSR-safe, non-hook read of the anonymous product analytics preference. */
export function readShareAnalytics(): boolean {
  return useOnboardingStore.getState().shareAnalytics;
}

/**
 * SSR-safe, non-hook check for a returning user signal.
 * Returns `true` when `onboarding.lastUserId` exists in localStorage,
 * indicating this browser has previously had a signed-in user. The key
 * persists through logout (by design), so a user who signs out and
 * revisits is still detected as "returning".
 */
export function hasReturningUserSignal(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return getDeviceSetting("lastUserId", "") !== "";
  } catch {
    return false;
  }
}

/**
 * Read the pinned release version the user picked on the privacy screen's
 * nonprod version selector. Empty string means "latest" / no pin. SSR-safe
 * and tolerant of disabled storage.
 */
export function readSelectedVersion(): string {
  if (typeof window === "undefined") return "";
  try {
    return getLocalSetting(KEY_SELECTED_VERSION, "");
  } catch {
    return "";
  }
}

/**
 * Persist (or clear) the pinned release version. An empty string clears
 * the key so the next hatch uses the managed "latest" default.
 */
export function writeSelectedVersion(version: string): void {
  if (typeof window === "undefined") return;
  try {
    if (version === "") {
      removeLocalSetting(KEY_SELECTED_VERSION);
    } else {
      setLocalSetting(KEY_SELECTED_VERSION, version);
    }
  } catch {
    // Storage unavailable — the hatch will fall back to "latest", which is
    // the right default.
  }
}


// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  KEY_TOS_ACCEPTED,
  KEY_AI_DATA_CONSENT,
  KEY_COMPLETED,
};
