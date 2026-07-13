/**
 * Versioned, per-user consent persistence.
 *
 * Consent flags live in `device:consent:{tos,privacy,share_analytics,share_diagnostics}:v<VERSION>:<userId>`.
 * The `device:` prefix survives logout; the userId makes them per-user;
 * the version lets us force re-consent by bumping the relevant version
 * constant. The four consent axes version independently — ToS, the privacy
 * checkbox (privacy policy + AI data sharing), share-analytics, and
 * share-diagnostics — so any one can be re-reviewed without forcing the
 * others. Bumping the privacy policy, in particular, must not re-prompt the
 * two data-capture toggles, so those carry their own frozen versions.
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
import { setDiagnosticsReportingGate } from "@/lib/consent/diagnostics-consent";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { patchConsent, type UserConsent } from "@/domains/account/profile";

// Consent versions must be zero-padded ISO dates (YYYY-MM-DD): currency is a
// monotonic comparison (`resolveServerConsent` uses `>=`), which requires a
// lexicographically sortable, chronological format.
export const TOS_CONSENT_VERSION = "2026-06-08";
export const PRIVACY_CONSENT_VERSION = "2026-06-22";

// The two data-capture toggles version independently from the privacy policy.
// Frozen at the prior privacy version (the value existing toggle acks/device
// keys are stamped under) so bumping the privacy policy doesn't re-prompt
// capture consent. Bump each independently when its own disclosure changes.
export const ANALYTICS_CONSENT_VERSION = "2026-06-18";
export const DIAGNOSTICS_CONSENT_VERSION = "2026-06-18";

// The privacy version that the legacy "ai"-named device key was last written
// under, before that field was folded into "privacy". Frozen as a literal (not
// PRIVACY_CONSENT_VERSION) so it keeps pointing at the real legacy key after
// the privacy version is bumped — letting us recognize and clean up that stale
// key rather than treating it as current consent.
const LEGACY_AI_PRIVACY_CONSENT_VERSION = "2026-06-08";

// Version stamp embedded in each field's device-cache key. ToS, the privacy
// checkbox (privacy policy + AI data sharing), and each share toggle track
// their own version constant.
const CONSENT_KEY_VERSION = {
  tos: TOS_CONSENT_VERSION,
  privacy: PRIVACY_CONSENT_VERSION,
  share_analytics: ANALYTICS_CONSENT_VERSION,
  share_diagnostics: DIAGNOSTICS_CONSENT_VERSION,
} as const;

function consentKey(field: keyof typeof CONSENT_KEY_VERSION, userId: string): string {
  return `device:consent:${field}:v${CONSENT_KEY_VERSION[field]}:${userId}`;
}

// The previous release stored privacy consent under a field named "ai" (now
// folded into "privacy"), written under LEGACY_AI_PRIVACY_CONSENT_VERSION.
function legacyPrivacyConsentKey(userId: string): string {
  return `device:consent:ai:v${LEGACY_AI_PRIVACY_CONSENT_VERSION}:${userId}`;
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
    const privacy = getLocalBool(consentKey("privacy", userId), false);

    // The legacy "ai"-named key was written under the previous privacy version,
    // so it cannot attest to the current one. Never promote it — that would
    // stamp stale consent as current. Clean it up if present so it doesn't
    // linger, and leave privacy un-set so the user re-reviews the updated
    // privacy checkbox.
    if (getLocalBool(legacyPrivacyConsentKey(userId), false)) {
      removeLocalSetting(legacyPrivacyConsentKey(userId));
    }

    if (tos || privacy) return { tos, privacy, analyticsCurrent, diagnosticsCurrent };

    // One-time migration: users who accepted before the per-user device
    // key change still have consent in the legacy vellum: active keys.
    // Promote ToS so they aren't re-prompted — its version is unchanged, so the
    // legacy acceptance is still current. The legacy privacy key is unversioned
    // and predates the current privacy version, so promoting it would stamp
    // stale consent as current (and let the empty-server fallback backfill it)
    // without showing the updated privacy checkbox. Force privacy through
    // re-review instead.
    const legacyTos = getLocalBool("vellum:onboarding:tosAccepted", false);
    const legacyPrivacy = getLocalBool("vellum:onboarding:aiDataConsent", false);
    if (legacyTos || legacyPrivacy) {
      persistConsentForUser(userId, legacyTos, false);
      return { tos: legacyTos, privacy: false, analyticsCurrent, diagnosticsCurrent };
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

/**
 * Whether a server-recorded `accepted` version satisfies the `required` build
 * version. Monotonic (`>=`): a version at or newer than the build's constant is
 * current, so a build never treats a newer client's acceptance as stale. `""`
 * (never accepted) sorts below any real version and stays stale. Relies on the
 * ISO-date version format (see the version constants above).
 */
function versionIsCurrent(accepted: string, required: string): boolean {
  return accepted >= required;
}

export function resolveServerConsent(
  consent: UserConsent | null | undefined,
): {
  tos: boolean;
  privacy: boolean;
  shareAnalytics: boolean | null;
  shareDiagnostics: boolean | null;
  analyticsCurrent: boolean;
  diagnosticsCurrent: boolean;
  /**
   * Raw version currency for each toggle — true only when the recorded
   * accepted version is at/past the build's constant. Unlike the `*Current`
   * flags (which also read never-asked as "nothing to re-review"), these back
   * the genuine "confirmed under the current version" attestation that may be
   * device-persisted or backfilled to the server.
   */
  analyticsVersionCurrent: boolean;
  diagnosticsVersionCurrent: boolean;
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
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: false,
      hasServerRecord: false,
    };
  }
  const analyticsVersionCurrent = versionIsCurrent(
    consent.share_analytics_accepted_version,
    ANALYTICS_CONSENT_VERSION,
  );
  const diagnosticsVersionCurrent = versionIsCurrent(
    consent.share_diagnostics_accepted_version,
    DIAGNOSTICS_CONSENT_VERSION,
  );
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
    // current only when BOTH versions are at or past the current version.
    tos: versionIsCurrent(consent.tos_accepted_version, TOS_CONSENT_VERSION),
    privacy:
      versionIsCurrent(consent.privacy_policy_accepted_version, PRIVACY_CONSENT_VERSION) &&
      versionIsCurrent(consent.ai_data_sharing_accepted_version, PRIVACY_CONSENT_VERSION),
    shareAnalytics: consent.share_analytics,
    shareDiagnostics: consent.share_diagnostics,
    // Share-toggle re-review is owed only for an explicit, genuinely stale
    // choice on record. Onboarding doesn't show the analytics toggle, so
    // `share_analytics` stays null until the user chooses via settings or
    // review-terms — null reads as "nothing to re-review". An implicit grant
    // — true with an EMPTY version — is never-asked in disguise, not stale
    // consent: a pre-nullable platform materializes its DB default `true` on
    // rows created without the toggle shown, while every explicit write
    // stamps a version. An explicit opt-out (false) is never excused this
    // way — a false with a stale/empty version still re-reviews.
    analyticsCurrent:
      consent.share_analytics === null ||
      (consent.share_analytics === true &&
        consent.share_analytics_accepted_version === "") ||
      analyticsVersionCurrent,
    diagnosticsCurrent:
      consent.share_diagnostics === null ||
      (consent.share_diagnostics === true &&
        consent.share_diagnostics_accepted_version === "") ||
      diagnosticsVersionCurrent,
    analyticsVersionCurrent,
    diagnosticsVersionCurrent,
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
  /**
   * Null when the toggle wasn't shown on the saving surface. No explicit
   * choice is recorded anywhere — the server keeps the column null and no
   * versioned device ack is stamped — but the in-memory currency flag is
   * still set: never-asked consent has nothing to re-review, so it must not
   * bounce the user to review-terms. A null diagnostics choice also leaves
   * the effective reporting gate untouched: a never-written gate reads open
   * by default (telemetry is opt-out), while an explicit device opt-out must
   * survive flows that don't show the toggle.
   */
  shareAnalytics: boolean | null;
  /** See {@link shareAnalytics}. */
  shareDiagnostics: boolean | null;
  hasPlatformSession: boolean;
}): void {
  const store = useOnboardingStore.getState();
  store.setTosAccepted(opts.tos);
  store.setPrivacyConsent(opts.privacy);
  if (opts.shareAnalytics !== null) {
    store.setShareAnalytics(opts.shareAnalytics);
  }
  if (opts.shareDiagnostics !== null) {
    store.setShareDiagnostics(opts.shareDiagnostics);
    // Only an explicit choice writes the gate; null leaves the existing
    // gate (and any explicit device opt-out) untouched.
    setDiagnosticsReportingGate(opts.shareDiagnostics);
  }
  store.setAnalyticsConsentCurrent(true);
  store.setDiagnosticsConsentCurrent(true);
  // An explicit user acceptance is authoritative hydration — route guards may
  // trust the flags without waiting for a session sync.
  store.setConsentHydrated(true);

  persistConsentForUser(opts.userId, opts.tos, opts.privacy);
  persistToggleConsent(opts.userId, {
    ...(opts.shareAnalytics !== null ? { analyticsCurrent: true } : {}),
    ...(opts.shareDiagnostics !== null ? { diagnosticsCurrent: true } : {}),
  });

  if (opts.hasPlatformSession) {
    void patchConsent({
      tos_accepted_version: opts.tos ? TOS_CONSENT_VERSION : "",
      privacy_policy_accepted_version: opts.privacy ? PRIVACY_CONSENT_VERSION : "",
      ai_data_sharing_accepted_version: opts.privacy ? PRIVACY_CONSENT_VERSION : "",
      ...(opts.shareAnalytics !== null
        ? {
            share_analytics: opts.shareAnalytics,
            share_analytics_accepted_version: ANALYTICS_CONSENT_VERSION,
          }
        : {}),
      ...(opts.shareDiagnostics !== null
        ? {
            share_diagnostics: opts.shareDiagnostics,
            share_diagnostics_accepted_version: DIAGNOSTICS_CONSENT_VERSION,
          }
        : {}),
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
    // Opt-out: the effective gate equals the preference — an explicit "off"
    // closes it, anything else keeps it open. The version-currency ack below
    // is separate: it is only earned with a live session to record it against.
    setDiagnosticsReportingGate(value);
    if (hasPlatformSession) {
      store.setDiagnosticsConsentCurrent(true);
      persistToggleConsent(userId, { diagnosticsCurrent: true });
    }
  }

  if (hasPlatformSession) {
    void patchConsent({
      [field]: value,
      [`${field}_accepted_version`]: CONSENT_KEY_VERSION[field],
    }).catch(() => {});
  }
}
