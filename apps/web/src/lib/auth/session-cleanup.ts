/**
 * Clear user-scoped browser storage on logout.
 *
 * Uses a preserve-list strategy: any localStorage key matching a known
 * app prefix is removed UNLESS it appears in the device-level preserve
 * set. This is future-proof — new app keys are cleared by default
 * without needing to update a removal list. Third-party keys (analytics
 * SDKs, Sentry, etc.) are untouched because they don't match app
 * prefixes.
 *
 * sessionStorage is cleared entirely — all keys are user-session-scoped.
 *
 * Called from the auth store's `logout()` action and from the
 * cross-tab BroadcastChannel handler before a hard page reload.
 *
 * References:
 * - https://web.dev/articles/sign-out-best-practices
 */

/** Prefixes that identify keys owned by this app. */
const APP_KEY_PREFIXES = [
  "vellum",
  "onboarding.",
  "ff:client:",
  "voice:",
  "integrations.",
];

/**
 * Device-level keys that must survive logout. These are preferences
 * scoped to the physical device, not to a user account.
 */
const DEVICE_LEVEL_KEYS = new Set([
  "vellum_theme",
  "vellum_share_analytics",
  "vellum_share_diagnostics",
  "onboarding.lastUserId",
]);

function isAppKey(key: string): boolean {
  return APP_KEY_PREFIXES.some((p) => key.startsWith(p));
}

export function clearUserScopedStorage(): void {
  try {
    sessionStorage.clear();
  } catch {
    // Storage unavailable (e.g. private browsing quota exceeded).
  }

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isAppKey(key) && !DEVICE_LEVEL_KEYS.has(key)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Storage unavailable.
  }
}
