/**
 * Clear user-scoped browser storage on logout.
 *
 * All app-owned localStorage keys use one of two prefixes:
 * - `vellum:` — user-scoped, cleared on logout
 * - `device:` — device-scoped, preserved across sessions
 *
 * This function removes every `vellum:` key while leaving `device:`
 * keys and third-party keys (analytics SDKs, Sentry, etc.) untouched.
 * sessionStorage is cleared entirely — all keys are session-scoped.
 *
 * Called from the auth store's `logout()` action and from the
 * cross-tab BroadcastChannel handler before a hard page reload.
 *
 * References:
 * - https://web.dev/articles/sign-out-best-practices
 * - LUM-2045 — Standardize key naming
 */

const USER_PREFIX = "vellum:";

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
      if (key && key.startsWith(USER_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Storage unavailable.
  }
}
