/**
 * Clear user-scoped browser storage on logout.
 *
 * Removes localStorage keys that hold per-user or per-assistant data
 * while preserving device-level preferences (theme, analytics/diagnostics
 * consent, returning-user signal). sessionStorage is cleared entirely —
 * all keys are session-scoped user data.
 *
 * Called from the auth store's `logout()` action and from the
 * cross-tab BroadcastChannel handler before a hard page reload.
 *
 * References:
 * - https://web.dev/articles/sign-out-best-practices
 */

const USER_SCOPED_PREFIXES = [
  "vellum:pinnedApps",
  "vellum:lastViewedConversation:",
  "vellum:sidebar-open-categories:",
  "vellum:sidebar-open-custom-groups:",
  "vellum_current_assistant_id__",
  "vellum:nudge-prefs",
  "vellum:edit-chat:",
  "ff:client:",
  "vellum_biometric_enabled",
  "onboarding.tosAccepted",
  "onboarding.aiDataConsent",
  "onboarding.completed",
  "onboarding.selectedVersion",
  "integrations.bannerDismissed",
  "voice:activationKey",
  "voice:ttsApiKey:",
  "voice:sttApiKey:",
];

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
      if (key && USER_SCOPED_PREFIXES.some((p) => key.startsWith(p))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Storage unavailable.
  }
}
