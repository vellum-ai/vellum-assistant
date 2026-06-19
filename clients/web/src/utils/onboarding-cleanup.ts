/**
 * Versioned, per-user consent persistence.
 *
 * Consent flags live in `device:consent:{tos,privacy,share_analytics,share_diagnostics}:v<VERSION>:<userId>`.
 * The `device:` prefix survives logout; the userId makes them per-user;
 * the version lets us force re-consent by bumping the relevant version
 * constant. The ToS legal terms version independently from the privacy
 * artifacts (privacy policy, AI data sharing, the share toggles), so each can
 * be re-reviewed without forcing the other.
 *
 * The `share_analytics`/`share_diagnostics` ack keys record the version under
 * which the toggle was last confirmed (its currency), independent of the
 * on/off value which lives in the unversioned `device:share_analytics` key.
 *
 * The onboarding Zustand store holds the in-memory state (`tosAccepted`,
 * `privacyConsent`). This module handles the durable device-key layer
 * and the unified read/write API for all consent state:
 *
 * - `resolveServerConsent` — compare server consent versions against the ToS/privacy versions
 * - `saveConsent`          — unified write: store + device keys + server sync
 * - `savePreferenceToggle` — single-field write for settings page toggles
 * - `restoreConsentForUser` — read device keys, return {tos, privacy, toggle acks}
 * - `persistConsentForUser` — write tos/privacy device keys
 * - `persistToggleConsent`  — write versioned share-toggle ack keys
 * - `clearConsentForUser`   — delete device keys + legacy active keys
 */
import { removeLocalSetting, getLocalBool, setLocalBool } from "@/utils/local-settings";
import { setDeviceBool } from "@/utils/device-settings";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { patchConsent, type UserConsent } from "@/domains/account/profile";

export const TOS_CONSENT_VERSION = "2026-06-08";
export const PRIVACY_CONSENT_VERSION = "2026-06-08";

// Version stamp embedded in each field's device-cache key. ToS tracks its own
// version; the privacy checkbox (privacy policy + AI data sharing) and the two
// share toggles track the privacy version.
const CONSENT_KEY_VERSION = {
  tos: TOS_CONSENT_VERSION,
  privacy: PRIVACY_CONSENT_VERSION,
  share_analytics: PRIVACY_CONSENT_VERSION,
  share_diagnostics: PRIVACY_CONSENT_VERSION,
} as const;

function consentKey(field: keyof typeof CONSENT_KEY_VERSION, userId: string): string {
  return `device:consent:${field}:v${CONSENT_KEY_VERSION[field]}:${userId}`;
}

// The previous release stored this consent under a field named "ai" (now folded
// into "privacy"). Read at the same version the old key was written under so an
// existing offline user with only the old key migrates cleanly instead of
// reading privacy=false and being re-routed through onboarding.
function legacyPrivacyConsentKey(userId: string): string {
  return `device:consent:ai:v${PRIVACY_CONSENT_VERSION}:${userId}`;
}

export function restoreConsentForUser(
  userId: string | null,
): { tos: boolean; privacy: boolean; analyticsCurrent: boolean; diagnosticsCurrent: boolean } {
  if (typeof window === "undefined" || !userId) {
    return { tos: false, privacy: false, analyticsCurrent: false, diagnosticsCurrent: false };
  }
  try {
    const analyticsCurrent = getLocalBool(consentKey("share_analytics", userId), false);
    const diagnosticsCurrent = getLocalBool(consentKey("share_diagnostics", userId), false);
    const tos = getLocalBool(consentKey("tos", userId), false);
    let privacy = getLocalBool(consentKey("privacy", userId), false);

    // Migrate the previous version's "ai"-named key into "privacy" so a renamed-
    // key user isn't read as un-consented (which the empty-server fallback would
    // turn into an onboarding re-route).
    if (!privacy && getLocalBool(legacyPrivacyConsentKey(userId), false)) {
      privacy = true;
      setLocalBool(consentKey("privacy", userId), true);
      removeLocalSetting(legacyPrivacyConsentKey(userId));
    }

    if (tos || privacy) return { tos, privacy, analyticsCurrent, diagnosticsCurrent };

    // One-time migration: users who accepted before the per-user device
    // key change still have consent in the legacy vellum: active keys.
    // Promote to the new keys so they aren't re-prompted.
    const legacyTos = getLocalBool("vellum:onboarding:tosAccepted", false);
    const legacyPrivacy = getLocalBool("vellum:onboarding:aiDataConsent", false);
    if (legacyTos || legacyPrivacy) {
      persistConsentForUser(userId, legacyTos, legacyPrivacy);
      return { tos: legacyTos, privacy: legacyPrivacy, analyticsCurrent, diagnosticsCurrent };
    }

    return { tos: false, privacy: false, analyticsCurrent, diagnosticsCurrent };
  } catch {
    return { tos: false, privacy: false, analyticsCurrent: false, diagnosticsCurrent: false };
  }
}

export function persistConsentForUser(
  userId: string | null,
  tos: boolean,
  privacy: boolean,
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    setLocalBool(consentKey("tos", userId), tos);
    setLocalBool(consentKey("privacy", userId), privacy);
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
    removeLocalSetting(consentKey("privacy", userId));
    removeLocalSetting(legacyPrivacyConsentKey(userId));
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
  privacy: boolean;
  shareAnalytics: boolean | null;
  shareDiagnostics: boolean | null;
  analyticsCurrent: boolean;
  diagnosticsCurrent: boolean;
  hasServerRecord: boolean;
} {
  if (!consent) {
    return {
      tos: false,
      privacy: false,
      shareAnalytics: null,
      shareDiagnostics: null,
      analyticsCurrent: false,
      diagnosticsCurrent: false,
      hasServerRecord: false,
    };
  }
  // The endpoint always returns an object; for a user with no stored row it
  // returns the API defaults (empty versions, share booleans true). Any
  // non-empty version or any `false` share boolean can only have come from a
  // real stored row, so it proves a record whose data is worth preserving.
  // Truthiness (not `!== ""`) so a response that OMITS the newer
  // share-version fields — e.g. an older backend during rollout — reads as
  // absent rather than as record evidence. `undefined` and `""` both mean
  // "no version on record".
  const hasServerRecord =
    !!consent.tos_accepted_version ||
    !!consent.privacy_policy_accepted_version ||
    !!consent.ai_data_sharing_accepted_version ||
    !!consent.share_analytics_accepted_version ||
    !!consent.share_diagnostics_accepted_version ||
    consent.share_analytics === false ||
    consent.share_diagnostics === false;
  return {
    // The ToS checkbox covers only the Terms of Service. The privacy checkbox
    // covers both the Privacy Policy and the AI Data Sharing Policy, so it is
    // current only when BOTH versions match.
    tos: consent.tos_accepted_version === TOS_CONSENT_VERSION,
    privacy: consent.privacy_policy_accepted_version === PRIVACY_CONSENT_VERSION
      && consent.ai_data_sharing_accepted_version === PRIVACY_CONSENT_VERSION,
    shareAnalytics: consent.share_analytics,
    shareDiagnostics: consent.share_diagnostics,
    analyticsCurrent: consent.share_analytics_accepted_version === PRIVACY_CONSENT_VERSION,
    diagnosticsCurrent: consent.share_diagnostics_accepted_version === PRIVACY_CONSENT_VERSION,
    hasServerRecord,
  };
}

// ---------------------------------------------------------------------------
// Unified write API
// ---------------------------------------------------------------------------

export function saveConsent(opts: {
  userId: string | null;
  tos: boolean;
  privacy: boolean;
  shareAnalytics: boolean;
  shareDiagnostics: boolean;
  hasPlatformSession: boolean;
}): void {
  const store = useOnboardingStore.getState();
  store.setTosAccepted(opts.tos);
  store.setPrivacyConsent(opts.privacy);
  store.setShareAnalytics(opts.shareAnalytics);
  store.setShareDiagnostics(opts.shareDiagnostics);
  store.setAnalyticsConsentCurrent(true);
  store.setDiagnosticsConsentCurrent(true);

  persistConsentForUser(opts.userId, opts.tos, opts.privacy);
  persistToggleConsent(opts.userId, { analyticsCurrent: true, diagnosticsCurrent: true });

  if (opts.hasPlatformSession) {
    void patchConsent({
      tos_accepted_version: opts.tos ? TOS_CONSENT_VERSION : "",
      privacy_policy_accepted_version: opts.privacy ? PRIVACY_CONSENT_VERSION : "",
      ai_data_sharing_accepted_version: opts.privacy ? PRIVACY_CONSENT_VERSION : "",
      share_analytics: opts.shareAnalytics,
      share_diagnostics: opts.shareDiagnostics,
      share_analytics_accepted_version: PRIVACY_CONSENT_VERSION,
      share_diagnostics_accepted_version: PRIVACY_CONSENT_VERSION,
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
  // The on/off value is always device-persisted, but the version-currency ack
  // ("confirmed under the current terms version") is only earned with a live
  // platform session to record it against — offline it would stamp a currency
  // the user never reviewed terms for.
  if (field === "share_analytics") {
    store.setShareAnalytics(value);
    setDeviceBool("shareAnalytics", value);
    if (hasPlatformSession) {
      store.setAnalyticsConsentCurrent(true);
      persistToggleConsent(userId, { analyticsCurrent: true });
    }
  } else {
    store.setShareDiagnostics(value);
    setDeviceBool("shareDiagnostics", value);
    if (hasPlatformSession) {
      store.setDiagnosticsConsentCurrent(true);
      persistToggleConsent(userId, { diagnosticsCurrent: true });
    }
  }

  if (hasPlatformSession) {
    void patchConsent({
      [field]: value,
      [`${field}_accepted_version`]: PRIVACY_CONSENT_VERSION,
    }).catch(() => {});
  }
}
