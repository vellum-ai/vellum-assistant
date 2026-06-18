/**
 * Versioned, per-user consent persistence.
 *
 * Consent flags live in `device:consent:{tos,ai,share_analytics,share_diagnostics}:v<VERSION>:<userId>`.
 * The `device:` prefix survives logout; the userId makes them per-user;
 * the version lets us force re-consent by bumping CONSENT_VERSION.
 *
 * The `share_analytics`/`share_diagnostics` ack keys record the version under
 * which the toggle was last confirmed (its currency), independent of the
 * on/off value which lives in the unversioned `device:share_analytics` key.
 *
 * The onboarding Zustand store holds the in-memory state (`tosAccepted`,
 * `aiDataConsent`). This module handles the durable device-key layer
 * and the unified read/write API for all consent state:
 *
 * - `resolveServerConsent` — compare server consent versions against CONSENT_VERSION
 * - `saveConsent`          — unified write: store + device keys + server sync
 * - `savePreferenceToggle` — single-field write for settings page toggles
 * - `restoreConsentForUser` — read device keys, return {tos, ai, toggle acks}
 * - `persistConsentForUser` — write tos/ai device keys
 * - `persistToggleConsent`  — write versioned share-toggle ack keys
 * - `clearConsentForUser`   — delete device keys + legacy active keys
 */
import { removeLocalSetting, getLocalBool, setLocalBool } from "@/utils/local-settings";
import { setDeviceBool } from "@/utils/device-settings";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { patchConsent, type UserConsent } from "@/domains/account/profile";

export const CONSENT_VERSION = "2026-06-08";

function consentKey(field: string, userId: string): string {
  return `device:consent:${field}:v${CONSENT_VERSION}:${userId}`;
}

export function restoreConsentForUser(
  userId: string | null,
): { tos: boolean; ai: boolean; analyticsCurrent: boolean; diagnosticsCurrent: boolean } {
  if (typeof window === "undefined" || !userId) {
    return { tos: false, ai: false, analyticsCurrent: false, diagnosticsCurrent: false };
  }
  try {
    const analyticsCurrent = getLocalBool(consentKey("share_analytics", userId), false);
    const diagnosticsCurrent = getLocalBool(consentKey("share_diagnostics", userId), false);
    const tos = getLocalBool(consentKey("tos", userId), false);
    const ai = getLocalBool(consentKey("ai", userId), false);
    if (tos || ai) return { tos, ai, analyticsCurrent, diagnosticsCurrent };

    // One-time migration: users who accepted before the per-user device
    // key change still have consent in the legacy vellum: active keys.
    // Promote to the new keys so they aren't re-prompted.
    const legacyTos = getLocalBool("vellum:onboarding:tosAccepted", false);
    const legacyAi = getLocalBool("vellum:onboarding:aiDataConsent", false);
    if (legacyTos || legacyAi) {
      persistConsentForUser(userId, legacyTos, legacyAi);
      return { tos: legacyTos, ai: legacyAi, analyticsCurrent, diagnosticsCurrent };
    }

    return { tos: false, ai: false, analyticsCurrent, diagnosticsCurrent };
  } catch {
    return { tos: false, ai: false, analyticsCurrent: false, diagnosticsCurrent: false };
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

export function persistToggleConsent(
  userId: string | null,
  acks: { analyticsCurrent?: boolean; diagnosticsCurrent?: boolean },
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    if (acks.analyticsCurrent !== undefined) {
      setLocalBool(consentKey("share_analytics", userId), acks.analyticsCurrent);
    }
    if (acks.diagnosticsCurrent !== undefined) {
      setLocalBool(consentKey("share_diagnostics", userId), acks.diagnosticsCurrent);
    }
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
    removeLocalSetting(consentKey("share_analytics", userId));
    removeLocalSetting(consentKey("share_diagnostics", userId));
  } catch {
    // Storage unavailable.
  }
}

// ---------------------------------------------------------------------------
// Server consent resolution
// ---------------------------------------------------------------------------

export function resolveServerConsent(
  consent: UserConsent | null | undefined,
): {
  tos: boolean;
  ai: boolean;
  shareAnalytics: boolean | null;
  shareDiagnostics: boolean | null;
  analyticsCurrent: boolean;
  diagnosticsCurrent: boolean;
} {
  if (!consent) {
    return {
      tos: false,
      ai: false,
      shareAnalytics: null,
      shareDiagnostics: null,
      analyticsCurrent: false,
      diagnosticsCurrent: false,
    };
  }
  return {
    tos: consent.tos_accepted_version === CONSENT_VERSION
      && consent.privacy_policy_accepted_version === CONSENT_VERSION,
    ai: consent.ai_data_sharing_accepted_version === CONSENT_VERSION,
    shareAnalytics: consent.share_analytics,
    shareDiagnostics: consent.share_diagnostics,
    analyticsCurrent: consent.share_analytics_accepted_version === CONSENT_VERSION,
    diagnosticsCurrent: consent.share_diagnostics_accepted_version === CONSENT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Unified write API
// ---------------------------------------------------------------------------

export function saveConsent(opts: {
  userId: string | null;
  tos: boolean;
  ai: boolean;
  shareAnalytics: boolean;
  shareDiagnostics: boolean;
  hasPlatformSession: boolean;
}): void {
  const store = useOnboardingStore.getState();
  store.setTosAccepted(opts.tos);
  store.setAiDataConsent(opts.ai);
  store.setShareAnalytics(opts.shareAnalytics);
  store.setShareDiagnostics(opts.shareDiagnostics);
  store.setAnalyticsConsentCurrent(true);
  store.setDiagnosticsConsentCurrent(true);

  persistConsentForUser(opts.userId, opts.tos, opts.ai);
  persistToggleConsent(opts.userId, { analyticsCurrent: true, diagnosticsCurrent: true });

  if (opts.hasPlatformSession) {
    void patchConsent({
      tos_accepted_version: opts.tos ? CONSENT_VERSION : "",
      privacy_policy_accepted_version: opts.tos ? CONSENT_VERSION : "",
      ai_data_sharing_accepted_version: opts.ai ? CONSENT_VERSION : "",
      share_analytics: opts.shareAnalytics,
      share_diagnostics: opts.shareDiagnostics,
      share_analytics_accepted_version: CONSENT_VERSION,
      share_diagnostics_accepted_version: CONSENT_VERSION,
    }).catch(() => {});
  }
}

export function savePreferenceToggle(
  field: "share_analytics" | "share_diagnostics",
  value: boolean,
  opts: { userId: string | null; hasPlatformSession: boolean },
): void {
  const store = useOnboardingStore.getState();
  const { userId, hasPlatformSession } = opts;
  if (field === "share_analytics") {
    store.setShareAnalytics(value);
    setDeviceBool("shareAnalytics", value);
    store.setAnalyticsConsentCurrent(true);
    persistToggleConsent(userId, { analyticsCurrent: true });
  } else {
    store.setShareDiagnostics(value);
    setDeviceBool("shareDiagnostics", value);
    store.setDiagnosticsConsentCurrent(true);
    persistToggleConsent(userId, { diagnosticsCurrent: true });
  }

  if (hasPlatformSession) {
    void patchConsent({
      [field]: value,
      [`${field}_accepted_version`]: CONSENT_VERSION,
    }).catch(() => {});
  }
}
