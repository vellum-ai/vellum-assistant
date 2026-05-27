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
} from "@/lib/local-settings";
import { getDeviceSetting, setDeviceSetting } from "@/lib/device-settings";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

// ---------------------------------------------------------------------------
// Storage keys (non-boolean — boolean keys live in onboarding-store.ts)
// ---------------------------------------------------------------------------

const KEY_TOS_ACCEPTED = "onboarding.tosAccepted";
const KEY_AI_DATA_CONSENT = "onboarding.aiDataConsent";
const KEY_COMPLETED = "onboarding.completed";
/**
 * Onboarding-only, nonprod-only: pinned release version for the hatch.
 * Written by the privacy screen's dev-tools version picker, read by the
 * hatching screen and forwarded to `hatchAssistant({ version })`. Empty
 * string / absent means "latest" (the normal managed default).
 */
const KEY_SELECTED_VERSION = "onboarding.selectedVersion";

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

/**
 * Remove per-user onboarding flags so a different account signing in on the
 * same browser isn't treated as already onboarded. Call this on logout.
 *
 * Intentionally leaves the `vellum_share_*` keys alone — those are framed as
 * device-level privacy preferences (shared with `/settings/privacy`) rather
 * than per-user state, and resetting them on every logout would clobber a
 * user's deliberate opt-out for the next user on a shared machine.
 *
 * Safe to call during SSR (no-op) and safe to call when keys are absent.
 */
export function clearOnboardingFlags(): void {
  useOnboardingStore.getState().resetOnboardingFlags();
  removeLocalSetting(KEY_SELECTED_VERSION);
  // `KEY_LAST_USER_ID` is deliberately preserved so a same-user re-login
  // doesn't look like a brand-new user to `syncOnboardingUser`. The stored
  // id is only relevant for identifying the *previous* user; clearing it
  // on logout would force the user through onboarding again on their next
  // sign-in even though `clearOnboardingFlags` already wiped their flags.
}

/**
 * Reconcile onboarding flags against the currently signed-in user.
 *
 * Clears stale `onboarding.*` flags whenever the active user id doesn't
 * match the one we last observed on this browser. That covers:
 *   - A different user signing in after session expiry / cookie clearing
 *     (the previous user never went through `logout()`, so the flags
 *     survived).
 *   - A different user signing in on the same browser after a fresh load
 *     (there was no previous in-memory user to compare against).
 *
 * When the new user id matches the stored one (same user signing back in),
 * this is a no-op so the user isn't forced through onboarding again.
 *
 * `userId === null` (signed-out) is also a no-op — we preserve the last
 * observed id across signed-out gaps so a same-user re-login is recognized.
 */
export function syncOnboardingUser(userId: string | null): void {
  if (typeof window === "undefined") return;
  if (userId === null) return;
  // All storage ops are guarded: this runs from `AuthProvider.setUser` on
  // every session update, so a throw here (disabled storage, private mode,
  // quota error) would propagate into auth initialization and could leave
  // `isLoading` stuck on first load. Failing soft degrades gracefully —
  // the worst case is a user who doesn't get their stale flags reconciled,
  // which matches how the rest of the onboarding surface treats storage
  // failures (see `onStart` and the hatch-success write).
  try {
    const stored = getDeviceSetting("lastUserId", "");
    if (stored === userId) return;
    // New user id (either different from stored, or storage was empty).
    // Any flags still in localStorage belong to a prior user — drop them
    // and remember the current user id for next time.
    useOnboardingStore.getState().resetOnboardingFlags();
    removeLocalSetting(KEY_SELECTED_VERSION);
    setDeviceSetting("lastUserId", userId);
  } catch {
    // Storage unavailable — nothing to reconcile.
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
