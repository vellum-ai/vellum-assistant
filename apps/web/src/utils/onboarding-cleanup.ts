/**
 * Versioned, per-user consent persistence.
 *
 * Consent flags live in `device:consent:{tos,ai}:v<VERSION>:<userId>`.
 * The `device:` prefix survives logout; the userId makes them per-user;
 * the version lets us force re-consent by bumping CONSENT_VERSION.
 *
 * The onboarding Zustand store holds the in-memory state (`tosAccepted`,
 * `aiDataConsent`). This module handles the durable device-key layer:
 *
 * - `restoreConsentForUser` — read device keys, return {tos, ai}
 * - `persistConsentForUser` — write device keys
 * - `clearConsentForUser`   — delete device keys + legacy active keys
 */
import { removeLocalSetting, getLocalBool, setLocalBool } from "@/utils/local-settings";

export const CONSENT_VERSION = "2026-06-08";

function consentKey(field: string, userId: string): string {
  return `device:consent:${field}:v${CONSENT_VERSION}:${userId}`;
}

export function restoreConsentForUser(userId: string | null): { tos: boolean; ai: boolean } {
  if (typeof window === "undefined" || !userId) return { tos: false, ai: false };
  try {
    return {
      tos: getLocalBool(consentKey("tos", userId), false),
      ai: getLocalBool(consentKey("ai", userId), false),
    };
  } catch {
    return { tos: false, ai: false };
  }
}

export function persistConsentForUser(
  userId: string | null,
  tos: boolean,
  ai: boolean,
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    setLocalBool(consentKey("tos", userId), tos);
    setLocalBool(consentKey("ai", userId), ai);
  } catch {
    // Storage unavailable.
  }
}

export function clearConsentForUser(userId: string | null): void {
  removeLocalSetting("vellum:onboarding:tosAccepted");
  removeLocalSetting("vellum:onboarding:aiDataConsent");
  removeLocalSetting("vellum:onboarding:selectedVersion");
  if (typeof window === "undefined" || !userId) return;
  try {
    removeLocalSetting(consentKey("tos", userId));
    removeLocalSetting(consentKey("ai", userId));
  } catch {
    // Storage unavailable.
  }
}
