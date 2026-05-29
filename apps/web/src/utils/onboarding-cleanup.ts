/**
 * Cross-domain onboarding cleanup utilities.
 *
 * These functions are consumed by the auth store (logout), settings
 * (retire assistant, debug controls), and are extracted here so domain
 * code doesn't reach into `domains/onboarding/` directly.
 *
 * Clears localStorage keys directly rather than going through the Zustand
 * store — all callers (logout, retire) navigate away immediately, so the
 * in-memory store state is irrelevant and reinitializes from localStorage
 * on the next page load.
 */
import { removeLocalSetting } from "@/utils/local-settings";
import { getDeviceSetting, setDeviceSetting } from "@/utils/device-settings";

/** Source of truth for onboarding key constants. Also imported by
 * `onboarding-store.ts`, `prefs.ts`, and `storage-migration.ts`. */
export const KEY_TOS_ACCEPTED = "vellum:onboarding:tosAccepted";
export const KEY_AI_DATA_CONSENT = "vellum:onboarding:aiDataConsent";
export const KEY_COMPLETED = "vellum:onboarding:completed";
const KEY_SELECTED_VERSION = "vellum:onboarding:selectedVersion";

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
  removeLocalSetting(KEY_AI_DATA_CONSENT);
  removeLocalSetting(KEY_COMPLETED);
  removeLocalSetting(KEY_SELECTED_VERSION);
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
  try {
    const stored = getDeviceSetting("lastUserId", "");
    if (stored === userId) return;
    clearOnboardingFlags();
    setDeviceSetting("lastUserId", userId);
  } catch {
    // Storage unavailable — nothing to reconcile.
  }
}
