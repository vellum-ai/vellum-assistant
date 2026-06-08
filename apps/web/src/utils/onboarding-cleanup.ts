/**
 * Cross-domain onboarding cleanup utilities.
 *
 * Consent flags (TOS + AI data sharing) are stored in two tiers:
 *
 * 1. **Active keys** (`vellum:onboarding:tosAccepted`, `…:aiDataConsent`) —
 *    read by the onboarding store and route guards. Cleared on logout by
 *    `clearUserScopedStorage()` along with all other `vellum:` keys.
 *
 * 2. **Durable per-user device keys** (`device:consent:tos:<userId>`,
 *    `device:consent:ai:<userId>`) — survive logout because they use the
 *    `device:` prefix, and are inherently per-user because the user id is
 *    embedded in the key.
 *
 * On login, `restoreConsentForUser(userId)` copies durable → active so the
 * route guard sees the returning user's prior consent. On consent submit,
 * `persistConsentForUser(userId)` copies active → durable so the values
 * survive the next logout cycle.
 */
import { removeLocalSetting, getLocalBool, setLocalBool } from "@/utils/local-settings";

export const KEY_TOS_ACCEPTED = "vellum:onboarding:tosAccepted";
export const KEY_AI_DATA_CONSENT = "vellum:onboarding:aiDataConsent";
const KEY_SELECTED_VERSION = "vellum:onboarding:selectedVersion";

function durableTosKey(userId: string): string {
  return `device:consent:tos:${userId}`;
}

function durableAiKey(userId: string): string {
  return `device:consent:ai:${userId}`;
}

/**
 * Restore a returning user's consent from durable device keys into the
 * active `vellum:` keys. The onboarding store picks up the writes via its
 * `watchSetting` listeners, so the in-memory state updates automatically.
 */
export function restoreConsentForUser(userId: string | null): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    const tos = getLocalBool(durableTosKey(userId), false);
    const ai = getLocalBool(durableAiKey(userId), false);
    if (tos) setLocalBool(KEY_TOS_ACCEPTED, tos);
    if (ai) setLocalBool(KEY_AI_DATA_CONSENT, ai);
  } catch {
    // Storage unavailable.
  }
}

/**
 * Persist the current active consent flags into durable per-user device
 * keys so they survive the next logout cycle.
 */
export function persistConsentForUser(userId: string | null): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    const tos = getLocalBool(KEY_TOS_ACCEPTED, false);
    const ai = getLocalBool(KEY_AI_DATA_CONSENT, false);
    setLocalBool(durableTosKey(userId), tos);
    setLocalBool(durableAiKey(userId), ai);
  } catch {
    // Storage unavailable.
  }
}

/**
 * Clear consent for a specific user — both active keys and durable device
 * keys. Also clears the dev-only selectedVersion pin.
 */
export function clearConsentForUser(userId: string | null): void {
  removeLocalSetting(KEY_TOS_ACCEPTED);
  removeLocalSetting(KEY_AI_DATA_CONSENT);
  removeLocalSetting(KEY_SELECTED_VERSION);
  if (typeof window === "undefined" || !userId) return;
  try {
    removeLocalSetting(durableTosKey(userId));
    removeLocalSetting(durableAiKey(userId));
  } catch {
    // Storage unavailable.
  }
}
