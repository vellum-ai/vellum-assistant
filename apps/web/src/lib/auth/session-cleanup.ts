/**
 * Clear user-scoped browser storage on logout.
 *
 * Any localStorage key starting with `device:` is automatically
 * preserved — these are device-scoped settings managed by
 * `lib/device-settings.ts`. All other keys matching app prefixes are
 * removed. Third-party keys (analytics SDKs, Sentry, etc.) are
 * untouched because they don't match app prefixes.
 *
 * The `DEVICE_LEVEL_KEYS` set below is a transitional safety net for
 * legacy (non-prefixed) device keys that haven't been migrated yet.
 * It will be removed once the `device:` namespace migration is
 * complete (see LUM-1933).
 *
 * sessionStorage is cleared entirely — all keys are user-session-scoped.
 *
 * Called from the auth store's `logout()` action and from the
 * cross-tab BroadcastChannel handler before a hard page reload.
 *
 * References:
 * - https://web.dev/articles/sign-out-best-practices
 */

import { DEVICE_PREFIX } from "@/lib/device-settings";

/** Prefixes that identify keys owned by this app. */
const APP_KEY_PREFIXES = [
  "vellum",
  "onboarding.",
  "ff:client:",
  "voice:",
  "integrations.",
  "gw:",
  "local:",
];

/**
 * Legacy device-level keys preserved as a transitional safety net.
 * After the `device:` namespace migration completes, this set is
 * removed — the prefix check handles everything. See LUM-1933.
 */
const DEVICE_LEVEL_KEYS = new Set([
  "vellum_theme",
  "vellum_share_analytics",
  "vellum_share_diagnostics",
  "vellum_biometric_enabled",
  "vellum_llm_log_retention",
  "vellum_timezone",
  "vellum_media_embeds_enabled",
  "vellum_media_embed_domains",
  "onboarding.lastUserId",
]);

function isAppKey(key: string): boolean {
  return APP_KEY_PREFIXES.some((p) => key.startsWith(p));
}

function isDeviceKey(key: string): boolean {
  return key.startsWith(DEVICE_PREFIX) || DEVICE_LEVEL_KEYS.has(key);
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
      if (key && isAppKey(key) && !isDeviceKey(key)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Storage unavailable.
  }
}
