/**
 * Onboarding preference hooks.
 *
 * Two groups of keys:
 *
 * 1. **Share preferences** — reused 1:1 with `/settings/privacy`:
 *    - `vellum_share_analytics` (default: "true")
 *    - `vellum_share_diagnostics` (default: "true")
 *    Writing from onboarding mutates the same localStorage entries the
 *    privacy settings page reads, so the two surfaces are a single source of
 *    truth.
 *
 * 2. **Onboarding-local flags** — under the `onboarding.*` namespace:
 *    - `onboarding.tosAccepted` (default: "false")
 *    - `onboarding.completed` (default: "false")
 *
 * Values are always persisted as the literal string `"true"` or `"false"`.
 *
 * Each hook is SSR-safe: it uses the default value for the server snapshot
 * and reads `localStorage` through `useSyncExternalStore` after hydration.
 * Tab-to-tab synchronization is supported via the `window.storage` event;
 * same-tab writes are synchronized through the shared local-settings event.
 */
import { useCallback, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/domains/settings/local-settings.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** Shared with `/settings/privacy`. Do NOT rename without migrating the other surface. */
const KEY_SHARE_ANALYTICS = "vellum_share_analytics";
/** Shared with `/settings/privacy`. Do NOT rename without migrating the other surface. */
const KEY_SHARE_DIAGNOSTICS = "vellum_share_diagnostics";

/** Onboarding-only: whether the user has accepted Terms of Service. */
const KEY_TOS_ACCEPTED = "onboarding.tosAccepted";
/**
 * Onboarding-only: explicit acknowledgment that conversation data is shared
 * with third-party AI providers (Anthropic, OpenAI, Google). Stored as a
 * separate flag from `KEY_TOS_ACCEPTED` because Apple Guideline 5.1.2(i)
 * requires AI data sharing consent to be SPECIFIC, not bundled with a
 * generic Terms of Service acceptance.
 */
const KEY_AI_DATA_CONSENT = "onboarding.aiDataConsent";
/** Onboarding-only: whether the user has completed the onboarding flow. */
const KEY_COMPLETED = "onboarding.completed";
/**
 * Onboarding-only, nonprod-only: pinned release version for the hatch.
 * Written by the privacy screen's dev-tools version picker, read by the
 * hatching screen and forwarded to `hatchAssistant({ version })`. Empty
 * string / absent means "latest" (the normal managed default).
 */
const KEY_SELECTED_VERSION = "onboarding.selectedVersion";
/**
 * Onboarding-only: last user id observed signed in on this browser. Used to
 * invalidate stale `onboarding.*` flags when a different user signs in on
 * the same machine without the previous user ever logging out (e.g. session
 * expiry, cookie clear, browser profile share).
 */
const KEY_LAST_USER_ID = "onboarding.lastUserId";
const LOCAL_SETTING_CHANGED_EVENT = "vellum:pref-changed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a boolean pref from localStorage. Returns `defaultValue` when:
 *   - running on the server (no `window`)
 *   - the key is absent
 *   - `localStorage.getItem` throws (e.g. private browsing quota)
 *
 * Values are recognized only as the literal strings `"true"` and `"false"`;
 * any other value falls through to `defaultValue`.
 */
function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = getLocalSetting(key, String(defaultValue));
    if (raw === "true") return true;
    if (raw === "false") return false;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Serialize and persist a boolean pref. No-op during SSR. */
function writeBooleanPref(key: string, value: boolean): void {
  setLocalSetting(key, value ? "true" : "false");
}

/**
 * Pure handler for a storage event targeting `key`. Returns the next value
 * the listener should apply, or `undefined` if the event is not for this
 * key (i.e. the listener should ignore it).
 *
 * Extracted from the hook so unit tests can exercise the tab-sync logic
 * without mounting React.
 */
function handleStorageEvent(
  event: StorageEvent,
  key: string,
  defaultValue: boolean,
): boolean | undefined {
  if (event.key !== key) return undefined;
  const next = event.newValue;
  if (next === "true") return true;
  if (next === "false") return false;
  return defaultValue;
}

function isLocalSettingChangedEventForKey(event: Event, key: string): boolean {
  const detail = (event as CustomEvent<{ key?: string | null }>).detail;
  return detail?.key === key;
}

/**
 * React hook that mirrors a boolean localStorage key into component state,
 * with cross-tab sync via the `storage` event.
 *
 * The hook seeds SSR/hydration with `defaultValue`, then uses React's
 * external-store contract to read the real stored value without setting
 * state synchronously from an effect.
 */
function useBooleanPref(
  key: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => {};

      const handleStorage = (event: StorageEvent) => {
        if (handleStorageEvent(event, key, defaultValue) !== undefined) {
          onStoreChange();
        }
      };

      const handleLocalSettingChange = (event: Event) => {
        if (isLocalSettingChangedEventForKey(event, key)) {
          onStoreChange();
        }
      };

      window.addEventListener("storage", handleStorage);
      window.addEventListener(
        LOCAL_SETTING_CHANGED_EVENT,
        handleLocalSettingChange,
      );
      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener(
          LOCAL_SETTING_CHANGED_EVENT,
          handleLocalSettingChange,
        );
      };
    },
    [key, defaultValue],
  );

  const getSnapshot = useCallback(
    () => readBooleanPref(key, defaultValue),
    [key, defaultValue],
  );

  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  const value = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setter = useCallback(
    (next: boolean) => {
      writeBooleanPref(key, next);
    },
    [key],
  );

  return [value, setter];
}
// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/**
 * Share anonymous product analytics. Defaults to `true`.
 * Backed by the SAME localStorage key as `/settings/privacy` so onboarding
 * and settings are a single source of truth.
 */
export function useShareAnalytics(): [boolean, (next: boolean) => void] {
  return useBooleanPref(KEY_SHARE_ANALYTICS, true);
}

/**
 * Share crash reports and diagnostics. Defaults to `true`.
 * Backed by the SAME localStorage key as `/settings/privacy`.
 */
export function useShareDiagnostics(): [boolean, (next: boolean) => void] {
  return useBooleanPref(KEY_SHARE_DIAGNOSTICS, true);
}

/** Whether the user accepted Terms of Service during onboarding. Defaults to `false`. */
export function useTosAccepted(): [boolean, (next: boolean) => void] {
  return useBooleanPref(KEY_TOS_ACCEPTED, false);
}

/**
 * Whether the user has explicitly acknowledged that conversation data is
 * sent to third-party AI providers. Defaults to `false`. Tracked separately
 * from `useTosAccepted` so the consent surface remains specific (Apple
 * Guideline 5.1.2(i)).
 */
export function useAiDataConsent(): [boolean, (next: boolean) => void] {
  return useBooleanPref(KEY_AI_DATA_CONSENT, false);
}

/** Whether the user completed the onboarding flow. Defaults to `false`. */
export function useOnboardingCompleted(): [boolean, (next: boolean) => void] {
  return useBooleanPref(KEY_COMPLETED, false);
}

// ---------------------------------------------------------------------------
// Non-hook helpers (for gates/guards outside React render)
// ---------------------------------------------------------------------------

/**
 * SSR-safe, non-hook read of the onboarding completion flag.
 * Returns `true` only when the stored value is the literal string `"true"`.
 */
export function readOnboardingCompleted(): boolean {
  return readBooleanPref(KEY_COMPLETED, false);
}

/**
 * SSR-safe, non-hook read of the TOS-accepted flag. Used by
 * `/onboarding/hatching` to refuse to provision an assistant if the user
 * navigated directly to that URL without ever seeing the privacy screen.
 */
export function readTosAccepted(): boolean {
  return readBooleanPref(KEY_TOS_ACCEPTED, false);
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
  return readBooleanPref(KEY_AI_DATA_CONSENT, false);
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
    return getLocalSetting(KEY_LAST_USER_ID, "") !== "";
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
  removeLocalSetting(KEY_TOS_ACCEPTED);
  // Apple Guideline 5.1.2(i): AI data sharing consent must be re-collected
  // on every fresh onboarding cycle (retire / logout). Leaving this set
  // would re-check the AI consent box automatically on the next visit to
  // `/onboarding/privacy`, defeating the explicit-consent guarantee.
  removeLocalSetting(KEY_AI_DATA_CONSENT);
  removeLocalSetting(KEY_COMPLETED);
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
    const stored = getLocalSetting(KEY_LAST_USER_ID, "");
    if (stored === userId) return;
    // New user id (either different from stored, or storage was empty).
    // Any flags still in localStorage belong to a prior user — drop them
    // and remember the current user id for next time.
    removeLocalSetting(KEY_TOS_ACCEPTED);
    removeLocalSetting(KEY_AI_DATA_CONSENT);
    removeLocalSetting(KEY_COMPLETED);
    removeLocalSetting(KEY_SELECTED_VERSION);
    setLocalSetting(KEY_LAST_USER_ID, userId);
  } catch {
    // Storage unavailable — nothing to reconcile.
  }
}

// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  KEY_SHARE_ANALYTICS,
  KEY_SHARE_DIAGNOSTICS,
  KEY_TOS_ACCEPTED,
  KEY_AI_DATA_CONSENT,
  KEY_COMPLETED,
  readBooleanPref,
  writeBooleanPref,
  handleStorageEvent,
};
