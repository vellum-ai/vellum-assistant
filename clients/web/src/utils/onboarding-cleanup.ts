/**
 * Versioned, per-user consent persistence.
 *
 * Consent acknowledgments live in per-user device keys
 * (`device:consent:{tos,privacy,share_diagnostics}:<userId>`) whose VALUE is
 * the required version the user last confirmed under (a zero-padded ISO
 * date). The `device:` prefix survives logout; the userId makes them
 * per-user. Currency is `storedVersion >= requiredVersion`, where the
 * required versions come from the server's `required_versions` (adopted by
 * `resolveServerConsent`) and fall back to the frozen build constants when
 * the backend predates the field — so a server-side version bump owes a
 * re-review without a client release. The consent axes version
 * independently — ToS, the privacy checkbox (privacy policy + AI data
 * sharing), and share-diagnostics — so any one can be re-reviewed without
 * forcing the others.
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
 * - `resolveServerConsent` — compare server consent versions against the required versions
 * - `saveConsent`          — unified write: store + device keys + server sync
 * - `savePreferenceToggle` — single-field write for settings page toggles
 * - `restoreConsentForUser` — read device keys, return {tos, privacy, diagnostics ack}
 * - `persistConsentForUser` — write tos/privacy device keys
 * - `persistToggleConsent`  — write the diagnostics ack key
 * - `clearConsentForUser`   — delete device keys + legacy active keys
 */
import {
  getLocalSetting,
  setLocalSetting,
  removeLocalSetting,
  getLocalBool,
} from "@/utils/local-settings";
import { applyExplicitDiagnosticsChoice } from "@/lib/consent/diagnostics-consent";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { patchConsent, type UserConsent } from "@/domains/account/profile";

// Offline/older-backend fallback required versions. The server's
// `required_versions` is authoritative when present; these frozen constants
// only back the paths where it isn't (a backend that predates the field, or
// no successful resolve yet this session). Zero-padded ISO dates
// (YYYY-MM-DD): currency is a monotonic comparison (`>=`), which requires a
// lexicographically sortable, chronological format.
export const TOS_CONSENT_VERSION = "2026-06-08";
export const PRIVACY_CONSENT_VERSION = "2026-06-22";

// The two data-capture toggles version independently from the privacy
// policy, so bumping the privacy policy doesn't re-prompt capture consent.
// Frozen at the prior privacy version as the fallback floor; genuine bumps
// arrive via the server's `required_versions`.
export const ANALYTICS_CONSENT_VERSION = "2026-06-18";
export const DIAGNOSTICS_CONSENT_VERSION = "2026-06-18";

// The privacy version that the legacy "ai"-named device key was last written
// under, before that field was folded into "privacy". Frozen as a literal (not
// PRIVACY_CONSENT_VERSION) so it keeps pointing at the real legacy key after
// the privacy version is bumped — letting us recognize and clean up that stale
// key rather than treating it as current consent.
const LEGACY_AI_PRIVACY_CONSENT_VERSION = "2026-06-08";

// ---------------------------------------------------------------------------
// Required versions — server-supplied, constants as fallback
// ---------------------------------------------------------------------------

interface RequiredConsentVersions {
  tos: string;
  privacyPolicy: string;
  aiDataSharing: string;
  shareAnalytics: string;
  shareDiagnostics: string;
}

const FALLBACK_REQUIRED_VERSIONS: RequiredConsentVersions = {
  tos: TOS_CONSENT_VERSION,
  privacyPolicy: PRIVACY_CONSENT_VERSION,
  aiDataSharing: PRIVACY_CONSENT_VERSION,
  shareAnalytics: ANALYTICS_CONSENT_VERSION,
  shareDiagnostics: DIAGNOSTICS_CONSENT_VERSION,
};

/**
 * The required versions from the most recent server consent record
 * `resolveServerConsent` saw, per-key falling back to the frozen constants.
 * `writeConsent` stamps PATCH bodies and the device-ack reads/writes consume
 * this, so the whole module agrees on one set of required versions: the
 * server's when it supplies them, the build's otherwise.
 */
let requiredVersions: RequiredConsentVersions = FALLBACK_REQUIRED_VERSIONS;

function toRequiredVersions(
  raw: Record<string, string> | undefined,
): RequiredConsentVersions {
  // `||` (not `??`): an empty string means "not supplied", never "nothing
  // required" — treating it as a requirement would mark every record current.
  return {
    tos: raw?.tos || TOS_CONSENT_VERSION,
    privacyPolicy: raw?.privacy_policy || PRIVACY_CONSENT_VERSION,
    aiDataSharing: raw?.ai_data_sharing || PRIVACY_CONSENT_VERSION,
    shareAnalytics: raw?.share_analytics || ANALYTICS_CONSENT_VERSION,
    shareDiagnostics: raw?.share_diagnostics || DIAGNOSTICS_CONSENT_VERSION,
  };
}

/** Test-only: restore the constants-fallback required versions. */
export function __resetRequiredConsentVersionsForTesting(): void {
  requiredVersions = FALLBACK_REQUIRED_VERSIONS;
}

// ---------------------------------------------------------------------------
// Device ack keys
// ---------------------------------------------------------------------------

// The three device-acknowledged axes: ToS, the privacy checkbox (privacy
// policy + AI data sharing), and the diagnostics toggle. Analytics has no
// device ack key.
type DeviceAckField = "tos" | "privacy" | "share_diagnostics";

function consentAckKey(field: DeviceAckField, userId: string): string {
  return `device:consent:${field}:${userId}`;
}

/** The required version a device ack for `field` must meet to be current. */
function requiredAckVersion(field: DeviceAckField): string {
  switch (field) {
    case "tos":
      return requiredVersions.tos;
    case "privacy":
      // One checkbox covers both privacy artifacts, so its ack must satisfy
      // whichever required version is newer.
      return requiredVersions.privacyPolicy >= requiredVersions.aiDataSharing
        ? requiredVersions.privacyPolicy
        : requiredVersions.aiDataSharing;
    case "share_diagnostics":
      return requiredVersions.shareDiagnostics;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The acknowledged version stored for `field`, or `""` when absent/garbled. */
function readAckVersion(field: DeviceAckField, userId: string): string {
  const value = getLocalSetting(consentAckKey(field, userId), "");
  return ISO_DATE_RE.test(value) ? value : "";
}

function isAckCurrent(field: DeviceAckField, userId: string): boolean {
  return versionIsCurrent(readAckVersion(field, userId), requiredAckVersion(field));
}

// The previous release stored privacy consent under a field named "ai" (now
// folded into "privacy"), written under LEGACY_AI_PRIVACY_CONSENT_VERSION.
function legacyPrivacyConsentKey(userId: string): string {
  return `device:consent:ai:v${LEGACY_AI_PRIVACY_CONSENT_VERSION}:${userId}`;
}

/**
 * One-time migration of the legacy ack layout, which embedded the version in
 * the KEY (`device:consent:<field>:v<VERSION>:<userId>`, boolean value).
 * When `promote` is set and no unversioned ack exists yet, the newest
 * affirmative legacy key's version becomes the unversioned key's value — the
 * legacy key attests exactly the version it was stamped under, so currency
 * against a later required version is decided by the comparison, never
 * assumed. Every legacy key for the field is then removed. Analytics runs
 * with `promote: false`: its device acks are dead (server-side stamps only),
 * so stale keys are deleted without promotion.
 */
function migrateLegacyVersionedAcks(
  field: DeviceAckField | "share_analytics",
  userId: string,
  promote: boolean,
): void {
  const prefix = `device:consent:${field}:v`;
  const suffix = `:${userId}`;
  const legacyKeys: string[] = [];
  let newestAcked = "";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) {
      continue;
    }
    const version = key.slice(prefix.length, key.length - suffix.length);
    // The version segment is always an ISO date; anything else is not a
    // legacy ack key (e.g. an unversioned key whose userId starts with "v").
    if (!ISO_DATE_RE.test(version)) {
      continue;
    }
    legacyKeys.push(key);
    if (getLocalBool(key, false) && version > newestAcked) {
      newestAcked = version;
    }
  }
  if (
    promote &&
    newestAcked &&
    field !== "share_analytics" &&
    !readAckVersion(field, userId)
  ) {
    setLocalSetting(consentAckKey(field, userId), newestAcked);
  }
  for (const key of legacyKeys) {
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
    migrateLegacyVersionedAcks("tos", userId, true);
    migrateLegacyVersionedAcks("privacy", userId, true);
    migrateLegacyVersionedAcks("share_diagnostics", userId, true);
    // Analytics device acks are never read (analytics is opt-out with
    // server-side version stamps only) — sweep stale keys, no promotion.
    migrateLegacyVersionedAcks("share_analytics", userId, false);

    // The legacy "ai"-named key was written under the previous privacy version,
    // so it cannot attest to the current one. Never promote it — that would
    // stamp stale consent as current. Clean it up if present so it doesn't
    // linger, and leave privacy un-set so the user re-reviews the updated
    // privacy checkbox.
    if (getLocalBool(legacyPrivacyConsentKey(userId), false)) {
      removeLocalSetting(legacyPrivacyConsentKey(userId));
    }

    const tos = isAckCurrent("tos", userId);
    const privacy = isAckCurrent("privacy", userId);
    const diagnosticsCurrent = isAckCurrent("share_diagnostics", userId);

    if (tos || privacy) {
      return { tos, privacy, diagnosticsCurrent };
    }

    // One-time migration: users who accepted before the per-user device
    // key change still have consent in the legacy vellum: active keys.
    // Promote ToS at the frozen constant — the version the legacy acceptance
    // actually attests — so a later required-version bump correctly reads it
    // stale instead of assuming currency. The legacy privacy key is
    // unversioned and predates the current privacy version, so promoting it
    // would stamp stale consent as current (and let the empty-server fallback
    // backfill it) without showing the updated privacy checkbox. Force
    // privacy through re-review instead.
    const legacyTos = getLocalBool("vellum:onboarding:tosAccepted", false);
    const legacyPrivacy = getLocalBool("vellum:onboarding:aiDataConsent", false);
    if (legacyTos || legacyPrivacy) {
      if (legacyTos) {
        setLocalSetting(consentAckKey("tos", userId), TOS_CONSENT_VERSION);
      }
      return {
        tos: legacyTos && isAckCurrent("tos", userId),
        privacy: false,
        diagnosticsCurrent,
      };
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
  if (typeof window === "undefined" || !userId) {
    return;
  }
  try {
    if (tos) {
      setLocalSetting(consentAckKey("tos", userId), requiredAckVersion("tos"));
    } else {
      removeLocalSetting(consentAckKey("tos", userId));
    }
    if (privacy) {
      setLocalSetting(
        consentAckKey("privacy", userId),
        requiredAckVersion("privacy"),
      );
    } else {
      removeLocalSetting(consentAckKey("privacy", userId));
    }
  } catch {
    // Storage unavailable.
  }
}

export function persistToggleConsent(
  userId: string | null,
  acks: { diagnosticsCurrent?: boolean },
): void {
  if (typeof window === "undefined" || !userId) {
    return;
  }
  try {
    if (acks.diagnosticsCurrent === true) {
      setLocalSetting(
        consentAckKey("share_diagnostics", userId),
        requiredAckVersion("share_diagnostics"),
      );
    } else if (acks.diagnosticsCurrent === false) {
      removeLocalSetting(consentAckKey("share_diagnostics", userId));
    }
  } catch {
    // Storage unavailable.
  }
}

export function clearConsentForUser(userId: string | null): void {
  removeLocalSetting("vellum:onboarding:tosAccepted");
  removeLocalSetting("vellum:onboarding:aiDataConsent");
  removeLocalSetting("vellum:onboarding:selectedVersion");
  if (typeof window === "undefined" || !userId) {
    return;
  }
  try {
    removeLocalSetting(consentAckKey("tos", userId));
    removeLocalSetting(consentAckKey("privacy", userId));
    removeLocalSetting(consentAckKey("share_diagnostics", userId));
    removeLocalSetting(legacyPrivacyConsentKey(userId));
    migrateLegacyVersionedAcks("tos", userId, false);
    migrateLegacyVersionedAcks("privacy", userId, false);
    migrateLegacyVersionedAcks("share_diagnostics", userId, false);
    migrateLegacyVersionedAcks("share_analytics", userId, false);
  } catch {
    // Storage unavailable.
  }
}

// ---------------------------------------------------------------------------
// Server consent resolution
// ---------------------------------------------------------------------------

/**
 * Whether a recorded `accepted` version satisfies the `required` version.
 * Monotonic (`>=`): a version at or newer than the requirement is current, so
 * a lagging requirement never treats a newer acceptance as stale. `""` (never
 * accepted) sorts below any real version and stays stale. Relies on the
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
   * accepted version is at/past the required version. Unlike the `*Current`
   * flags (which also read never-asked as "nothing to re-review"), these back
   * the genuine "confirmed under the current version" attestation that may be
   * device-persisted or backfilled to the server.
   */
  analyticsVersionCurrent: boolean;
  diagnosticsVersionCurrent: boolean;
  hasServerRecord: boolean;
} {
  if (!consent) {
    // No server record to resolve — and no required-version information, so
    // the module keeps whatever required versions it last adopted.
    return {
      tos: false,
      privacy: false,
      shareAnalytics: null,
      shareDiagnostics: null,
      // Opt-out semantics default to enabled, matching the fallback chain
      // applied to an all-null record.
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: false,
      diagnosticsCurrent: false,
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: false,
      hasServerRecord: false,
    };
  }
  // The server is the source of truth for which versions are required: adopt
  // its `required_versions` (per-key constants fallback for an older backend
  // that omits the field) and remember them module-wide, so device-ack
  // currency checks and PATCH version stamps agree with this resolution.
  const required = toRequiredVersions(consent.required_versions);
  requiredVersions = required;

  const analyticsVersionCurrent = versionIsCurrent(
    consent.share_analytics_accepted_version,
    required.shareAnalytics,
  );
  const diagnosticsVersionCurrent = versionIsCurrent(
    consent.share_diagnostics_accepted_version,
    required.shareDiagnostics,
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
    // current only when BOTH artifacts meet their own required versions.
    tos: versionIsCurrent(consent.tos_accepted_version, required.tos),
    privacy:
      versionIsCurrent(
        consent.privacy_policy_accepted_version,
        required.privacyPolicy,
      ) &&
      versionIsCurrent(
        consent.ai_data_sharing_accepted_version,
        required.aiDataSharing,
      ),
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
 * Version stamps — device acks and PATCH bodies — use the module's required
 * versions: server-supplied when the last `resolveServerConsent` saw a
 * record, the frozen constants otherwise (offline, older backend).
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
            tos_accepted_version: legal.tos ? requiredVersions.tos : "",
            privacy_policy_accepted_version: legal.privacy
              ? requiredVersions.privacyPolicy
              : "",
            ai_data_sharing_accepted_version: legal.privacy
              ? requiredVersions.aiDataSharing
              : "",
          }
        : {}),
      ...(shareAnalytics !== undefined
        ? {
            share_analytics: shareAnalytics,
            share_analytics_accepted_version: requiredVersions.shareAnalytics,
          }
        : {}),
      ...(shareDiagnostics !== undefined
        ? {
            share_diagnostics: shareDiagnostics,
            share_diagnostics_accepted_version:
              requiredVersions.shareDiagnostics,
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
