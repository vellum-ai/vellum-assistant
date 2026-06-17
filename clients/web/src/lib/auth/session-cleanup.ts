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
 * Legacy prefixes are also swept as a safety net: if the startup
 * migration in `storage-migration.ts` failed (e.g. QuotaExceededError),
 * old key names would survive without this fallback. Particularly
 * important for auth tokens (`gw:*`). This sweep can be removed
 * once we're confident all users have been migrated.
 *
 * Called from the auth store's `logout()` action and from the
 * cross-tab BroadcastChannel handler before a hard page reload.
 *
 * References:
 * - https://web.dev/articles/sign-out-best-practices
 */

const USER_PREFIX = "vellum:";

/**
 * Legacy key prefixes that were user-scoped before the `vellum:`
 * standardization. Swept as a fallback in case startup migration failed.
 */
const LEGACY_USER_PREFIXES = [
  "onboarding.",
  "voice:",
  "gw:",
  "ff:client:",
  "local:",
  "integrations.",
  "vellumDebug.",
  "vellum_",
];

/**
 * Legacy device-level keys that used the `vellum_` prefix.
 * Must NOT be cleaned on logout — they are device-scoped settings.
 * Normally these have been migrated to `device:*` by
 * `migrateDeviceSettings()`, but if that migration also failed,
 * this set prevents accidental deletion.
 */
const LEGACY_DEVICE_KEYS = new Set([
  "vellum_theme",
  "vellum_share_analytics",
  "vellum_share_diagnostics",
  "vellum_biometric_enabled",
  "vellum_llm_log_retention",
  "vellum_timezone",
  "vellum_media_embeds_enabled",
  "vellum_media_embed_domains",
  "onboarding.lastUserId", // matches "onboarding." prefix but is device-scoped
]);

function isUserScopedKey(key: string): boolean {
  if (key.startsWith(USER_PREFIX)) return true;
  if (LEGACY_DEVICE_KEYS.has(key)) return false;
  return LEGACY_USER_PREFIXES.some((prefix) => key.startsWith(prefix));
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
      if (key && isUserScopedKey(key)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Storage unavailable.
  }
}
