/**
 * Onboarding preference public API.
 *
 * Boolean preferences (`shareAnalytics`, `shareDiagnostics`, `tosAccepted`,
 * `privacyConsent`) are owned by `useOnboardingStore` — a
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
import { getDeviceBool } from "@/utils/device-settings";
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
 * Whether the user accepted the Privacy Policy and AI Data Sharing Policy
 * (the second onboarding checkbox). Defaults to `false`. Tracked separately
 * from `useTosAccepted` so the consent surface remains specific (Apple
 * Guideline 5.1.2(i)).
 */
export function usePrivacyConsent(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.privacyConsent();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setPrivacyConsent(next);
  }, []);
  return [value, setter];
}

/**
 * Whether the analytics consent the user accepted is for the current toggle
 * version. Set on session sync by the auth store. A stale value means the user
 * must re-review the terms.
 */
export function useAnalyticsConsentCurrent(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.analyticsConsentCurrent();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setAnalyticsConsentCurrent(next);
  }, []);
  return [value, setter];
}

/**
 * Whether the diagnostics consent the user accepted is for the current toggle
 * version. Set on session sync by the auth store. A stale value means the user
 * must re-review the terms.
 */
export function useDiagnosticsConsentCurrent(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.diagnosticsConsentCurrent();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setDiagnosticsConsentCurrent(next);
  }, []);
  return [value, setter];
}

// ---------------------------------------------------------------------------
// Non-hook readers (for gates/guards outside React render)
// ---------------------------------------------------------------------------

/**
 * SSR-safe, non-hook read of the TOS-accepted flag. Used by
 * `/onboarding/hatching` to refuse to provision an assistant if the user
 * navigated directly to that URL without ever seeing the privacy screen.
 */
export function readTosAccepted(): boolean {
  return useOnboardingStore.getState().tosAccepted;
}

/**
 * SSR-safe, non-hook read of the Privacy Policy + AI Data Sharing consent
 * flag. Used alongside `readTosAccepted()` by the hatching gate so a user who
 * somehow has only one of the two acknowledgments persisted (storage
 * race, partial restore from a sync mechanism) is bounced back through
 * the privacy screen rather than allowed to provision an assistant
 * without explicit privacy consent.
 */
export function readPrivacyConsent(): boolean {
  return useOnboardingStore.getState().privacyConsent;
}

/**
 * SSR-safe, non-hook read of whether analytics consent is for the current
 * toggle version. Used by the navigation guard to redirect platform users
 * back to review-terms when their consent has gone stale.
 */
export function readAnalyticsConsentCurrent(): boolean {
  return useOnboardingStore.getState().analyticsConsentCurrent;
}

/**
 * SSR-safe, non-hook read of whether diagnostics consent is for the current
 * toggle version. Used alongside `readAnalyticsConsentCurrent()` by the
 * navigation guard.
 */
export function readDiagnosticsConsentCurrent(): boolean {
  return useOnboardingStore.getState().diagnosticsConsentCurrent;
}

/**
 * SSR-safe, non-hook read of whether the consent flags reflect a completed
 * session sync (or an explicit user acceptance). Used by the navigation guard
 * to defer consent-based redirects until the flags are trustworthy — the
 * flags boot `false` and only reflect reality once hydration lands.
 */
export function readConsentHydrated(): boolean {
  return useOnboardingStore.getState().consentHydrated;
}

/**
 * SSR-safe, non-hook read for telemetry emitters.
 *
 * Analytics is opt-out: an absent preference (never asked) authorizes uploads;
 * only an explicit opt-out stops them. The in-memory store must also agree so
 * a failed opt-out write cannot leave an older stored opt-in authorizing a new
 * event.
 */
export function readShareAnalytics(): boolean {
  return (
    useOnboardingStore.getState().shareAnalytics &&
    getDeviceBool("shareAnalytics", true)
  );
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


