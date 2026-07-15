/**
 * Versioned, per-user consent persistence.
 *
 * Consent flags live in `device:consent:{tos,privacy,share_diagnostics}:v<VERSION>:<userId>`.
 * The `device:` prefix survives logout; the userId makes them per-user;
 * the version lets us force re-consent by bumping the relevant version
 * constant. The consent axes version independently — ToS, the privacy
 * checkbox (privacy policy + AI data sharing), and share-diagnostics — so any
 * one can be re-reviewed without forcing the others. Bumping the privacy
 * policy, in particular, must not re-prompt diagnostics capture consent, so
 * it carries its own frozen version.
 *
 * The `share_diagnostics` ack key records the version under which the toggle
 * was last confirmed (its currency), independent of the on/off value which
 * lives in the unversioned `device:share_diagnostics` key. Analytics has no
 * device ack: it is opt-out and its toggle is never shown during onboarding,
 * so there is no versioned acknowledgment to preserve — server-side version
 * stamps are written directly at choice time.
 *
 * The onboarding Zustand store holds the in-memory state (`tosAccepted`,
 * `privacyConsent`). This module handles the durable device-key layer
 * and the unified read/write API for all consent state:
 *
 * - `resolveServerConsent` — compare server consent versions against the ToS/privacy versions
 * - `saveConsent`          — unified write: store + device keys + server sync
 * - `savePreferenceToggle` — single-field write for settings page toggles
 * - `restoreConsentForUser` — read device keys, return {tos, privacy, diagnostics ack}
 * - `persistConsentForUser` — write tos/privacy device keys
 * - `persistToggleConsent`  — write the versioned diagnostics ack key
 * - `clearConsentForUser`   — delete device keys + legacy active keys
 */
import { removeLocalSetting, getLocalBool, setLocalBool } from "@/utils/local-settings";
import { applyExplicitDiagnosticsChoice } from "@/lib/consent/diagnostics-consent";
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
// checkbox (privacy policy + AI data sharing), and the diagnostics toggle
// track their own version constant. Analytics has no device ack key.
const CONSENT_KEY_VERSION = {
  tos: TOS_CONSENT_VERSION,
  privacy: PRIVACY_CONSENT_VERSION,
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

// Analytics device acks are no longer read or written (analytics is opt-out
// and its toggle is never shown during onboarding — server version stamps are
// written at choice time instead). Delete any stale keys, whatever version
// they were stamped under, so they don't linger.
function removeStaleAnalyticsAckKeys(userId: string): void {
  const prefix = "device:consent:share_analytics:v";
  const suffix = `:${userId}`;
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix) && key.endsWith(suffix)) {
      stale.push(key);
    }
  }
  for (const key of stale) {
    removeLocalSetting(key);
  }
}

export function restoreConsentForUser(
  userId: string | null,
): { tos: boolean; privacy: boolean; diagnosticsCurrent: boolean } {
  if (typeof window === "undefined" || !userId) {
    return { tos: false, privacy: false, diagnosticsCurrent: false };
  }
  try {
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
    removeStaleAnalyticsAckKeys(userId);

    if (tos || privacy) {
      return { tos, privacy, diagnosticsCurrent };
    }

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
      return { tos: legacyTos, privacy: false, diagnosticsCurrent };
    }

    return { tos: false, privacy: false, diagnosticsCurrent };
  } catch {
    return { tos: false, privacy: false, diagnosticsCurrent: false };
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
  acks: { diagnosticsCurrent?: boolean },
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
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
    removeStaleAnalyticsAckKeys(userId);
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
  /**
   * Server-computed effective consent (opt-out semantics: null/never-asked =
   * enabled). This is the value data-capture gates should honor; the raw
   * `share*` fields above stay tri-state for chosen-ness.
   */
  analyticsEffective: boolean;
  diagnosticsEffective: boolean;
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
      // No server record to resolve; opt-out semantics default to enabled,
      // matching the fallback chain applied to an all-null record.
      analyticsEffective: true,
      diagnosticsEffective: true,
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
  // returns the API defaults (empty versions, null share booleans). Any
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
    // Raw tri-state chosen-ness: null = never asked, boolean = explicit
    // choice. The platform stores explicit choices only, so the value can be
    // consumed verbatim.
    shareAnalytics: consent.share_analytics,
    shareDiagnostics: consent.share_diagnostics,
    // The platform computes effective consent in one place (null = enabled,
    // opt-out) and serves it as `share_*_effective`. The fields are required
    // in the current schema, but an older backend omits them — fall back to
    // the raw value's opt-out reading so behavior is unchanged there.
    analyticsEffective: consent.share_analytics_effective ?? consent.share_analytics ?? true,
    diagnosticsEffective:
      consent.share_diagnostics_effective ?? consent.share_diagnostics ?? true,
    // Share-toggle re-review is owed only for an explicit, genuinely stale
    // choice on record. Onboarding doesn't show the analytics toggle, so
    // `share_analytics` stays null until the user chooses via settings or
    // review-terms — null reads as "nothing to re-review", not stale consent.
    // An explicit choice with a stale/empty version still re-reviews.
    analyticsCurrent: consent.share_analytics === null || analyticsVersionCurrent,
    diagnosticsCurrent: consent.share_diagnostics === null || diagnosticsVersionCurrent,
    analyticsVersionCurrent,
    diagnosticsVersionCurrent,
    hasServerRecord,
  };
}

// ---------------------------------------------------------------------------
// Unified write API
// ---------------------------------------------------------------------------

/**
 * The single internal write path for user-initiated consent: store updates,
 * per-user device keys, the diagnostics gate chokepoint, and the server
 * PATCH. `saveConsent` and `savePreferenceToggle` are thin argument-shapers
 * over it.
 *
 * `legal` is present only for a consent-screen save; that acceptance is an
 * explicit review of the current terms, so currency and hydration are
 * authoritative without a live session. A lone toggle write earns version
 * currency only with a live platform session to record it against — offline
 * it would stamp a currency the user never reviewed terms for. A share field
 * is written only when its toggle was actually shown (`undefined` = absent =
 * nothing persisted anywhere for that axis).
 */
function writeConsent(
  fields: {
    legal?: { tos: boolean; privacy: boolean };
    shareAnalytics?: boolean;
    shareDiagnostics?: boolean;
  },
  opts: { userId: string | null; hasPlatformSession: boolean },
): void {
  const { legal, shareAnalytics, shareDiagnostics } = fields;
  const store = useOnboardingStore.getState();

  if (legal) {
    store.setTosAccepted(legal.tos);
    store.setPrivacyConsent(legal.privacy);
    persistConsentForUser(opts.userId, legal.tos, legal.privacy);
  }
  if (shareAnalytics !== undefined) {
    store.setShareAnalytics(shareAnalytics);
  }
  if (shareDiagnostics !== undefined) {
    // Opt-out: the effective reporting gate equals the preference — an
    // explicit "off" closes it, "on" opens it. Routed through the diagnostics
    // chokepoint, the gate key's single writer. An absent choice leaves the
    // gate (and any explicit device opt-out) untouched.
    applyExplicitDiagnosticsChoice(shareDiagnostics, store.setShareDiagnostics);
  }

  // A consent screen settles both share axes as current — never-asked has
  // nothing to re-review, so it must not bounce the user to review-terms —
  // and is authoritative hydration: route guards may trust the flags without
  // waiting for a session sync. A settings toggle marks only its own axis,
  // and only with a live session.
  if (legal) {
    store.setAnalyticsConsentCurrent(true);
    store.setDiagnosticsConsentCurrent(true);
    store.setConsentHydrated(true);
  } else if (opts.hasPlatformSession) {
    if (shareAnalytics !== undefined) {
      store.setAnalyticsConsentCurrent(true);
    }
    if (shareDiagnostics !== undefined) {
      store.setDiagnosticsConsentCurrent(true);
    }
  }

  // The versioned diagnostics ack ("confirmed under the current version") is
  // earned by a consent-screen review, or by a toggle change made with a live
  // session to record it against. Analytics has no device ack.
  if (shareDiagnostics !== undefined && (legal || opts.hasPlatformSession)) {
    persistToggleConsent(opts.userId, { diagnosticsCurrent: true });
  }

  if (opts.hasPlatformSession) {
    void patchConsent({
      ...(legal
        ? {
            tos_accepted_version: legal.tos ? TOS_CONSENT_VERSION : "",
            privacy_policy_accepted_version: legal.privacy
              ? PRIVACY_CONSENT_VERSION
              : "",
            ai_data_sharing_accepted_version: legal.privacy
              ? PRIVACY_CONSENT_VERSION
              : "",
          }
        : {}),
      ...(shareAnalytics !== undefined
        ? {
            share_analytics: shareAnalytics,
            share_analytics_accepted_version: ANALYTICS_CONSENT_VERSION,
          }
        : {}),
      ...(shareDiagnostics !== undefined
        ? {
            share_diagnostics: shareDiagnostics,
            share_diagnostics_accepted_version: DIAGNOSTICS_CONSENT_VERSION,
          }
        : {}),
    }).catch(() => {});
  }
}

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
  writeConsent(
    {
      legal: { tos: opts.tos, privacy: opts.privacy },
      ...(opts.shareAnalytics !== null
        ? { shareAnalytics: opts.shareAnalytics }
        : {}),
      ...(opts.shareDiagnostics !== null
        ? { shareDiagnostics: opts.shareDiagnostics }
        : {}),
    },
    { userId: opts.userId, hasPlatformSession: opts.hasPlatformSession },
  );
}

export function savePreferenceToggle(
  field: "share_analytics" | "share_diagnostics",
  value: boolean,
  opts: { userId: string | null; hasPlatformSession: boolean },
): void {
  writeConsent(
    field === "share_analytics"
      ? { shareAnalytics: value }
      : { shareDiagnostics: value },
    opts,
  );
}
