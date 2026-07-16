/**
 * Tests for the versioned share-toggle consent layer in `consent-persistence`.
 *
 * Collaborators (`onboarding-store`, `profile.patchConsent`,
 * `device-settings`) are mocked so we exercise the per-user device-key
 * read/write logic in isolation against an in-memory `localStorage`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { installMemoryStorage } from "@/utils/memory-storage.test-helper";
import type { ConsentPatch } from "@/domains/account/profile";

installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

const storeState = {
  setTosAccepted: mock(() => {}),
  setPrivacyConsent: mock(() => {}),
  setShareAnalytics: mock(() => {}),
  setPendingAnalyticsOptIn: mock(() => {}),
  setShareDiagnostics: mock(() => {}),
  setAnalyticsConsentCurrent: mock(() => {}),
  setDiagnosticsConsentCurrent: mock(() => {}),
  setConsentHydrated: mock(() => {}),
};
mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: { getState: () => storeState },
}));

// `consent-persistence` only needs `patchConsent`; the real `profile` module
// pulls in the generated API client (unavailable in unit tests), so stub it.
const patchConsentMock = mock(async (_consent: ConsentPatch) => {});
mock.module("@/domains/account/profile", () => ({
  patchConsent: patchConsentMock,
}));
mock.module("@/generated/api/client.gen", () => ({ client: {} }));

const setDeviceBoolMock = mock((_name: string, _value: boolean) => {});
mock.module("@/utils/device-settings", () => ({
  setDeviceBool: setDeviceBoolMock,
  // The real diagnostics-consent chokepoint runs against this mock; provide
  // its read surface (only reached on unknown inputs, never for the explicit
  // choices these tests exercise).
  getDeviceBool: (_name: string, fallback: boolean) => fallback,
  getDeviceSetting: (_name: string, fallback: string) => fallback,
}));

import {
  TOS_CONSENT_VERSION,
  PRIVACY_CONSENT_VERSION,
  ANALYTICS_CONSENT_VERSION,
  DIAGNOSTICS_CONSENT_VERSION,
  __resetRequiredConsentVersionsForTesting,
  clearConsentForUser,
  persistDiagnosticsAck,
  resolveServerConsent,
  restoreConsentForUser,
  saveConsent,
  savePreferenceToggle,
} from "@/lib/consent/consent-persistence";
import type { UserConsent } from "@/domains/account/profile";

function makeConsent(overrides: Partial<UserConsent> = {}): UserConsent {
  const base: UserConsent = {
    tos_accepted_version: TOS_CONSENT_VERSION,
    tos_accepted_at: null,
    privacy_policy_accepted_version: PRIVACY_CONSENT_VERSION,
    privacy_policy_accepted_at: null,
    ai_data_sharing_accepted_version: PRIVACY_CONSENT_VERSION,
    ai_data_sharing_accepted_at: null,
    share_analytics: true,
    share_diagnostics: true,
    share_analytics_effective: true,
    share_diagnostics_effective: true,
    share_analytics_accepted_version: ANALYTICS_CONSENT_VERSION,
    share_analytics_accepted_at: null,
    share_diagnostics_accepted_version: DIAGNOSTICS_CONSENT_VERSION,
    share_diagnostics_accepted_at: null,
    required_versions: {
      tos: TOS_CONSENT_VERSION,
      privacy_policy: PRIVACY_CONSENT_VERSION,
      ai_data_sharing: PRIVACY_CONSENT_VERSION,
      share_analytics: ANALYTICS_CONSENT_VERSION,
      share_diagnostics: DIAGNOSTICS_CONSENT_VERSION,
    },
    ...overrides,
  };
  // Mirror the wire contract unless a test overrides the effective fields
  // directly: the platform computes effective = value ?? true (opt-out).
  return {
    ...base,
    share_analytics_effective:
      overrides.share_analytics_effective ?? base.share_analytics ?? true,
    share_diagnostics_effective:
      overrides.share_diagnostics_effective ?? base.share_diagnostics ?? true,
  };
}

// A server-side bump newer than every frozen build constant.
const BUMPED_VERSION = "2026-08-01";
const BUMPED_REQUIRED_VERSIONS = {
  tos: BUMPED_VERSION,
  privacy_policy: BUMPED_VERSION,
  ai_data_sharing: BUMPED_VERSION,
  share_analytics: BUMPED_VERSION,
  share_diagnostics: BUMPED_VERSION,
};

// Unversioned per-user ack keys; the VALUE is the acknowledged version.
const tosAckKey = (userId: string) => `device:consent:tos:${userId}`;
const privacyPolicyAckKey = (userId: string) =>
  `device:consent:privacy_policy:${userId}`;
const aiDataSharingAckKey = (userId: string) =>
  `device:consent:ai_data_sharing:${userId}`;
const diagnosticsKey = (userId: string) =>
  `device:consent:share_diagnostics:${userId}`;
// Legacy layout: the version was embedded in the KEY over a boolean value.
const legacyVersionedKey = (field: string, version: string, userId: string) =>
  `device:consent:${field}:v${version}:${userId}`;
const analyticsKey = (userId: string) =>
  legacyVersionedKey("share_analytics", ANALYTICS_CONSENT_VERSION, userId);

beforeEach(() => {
  __resetRequiredConsentVersionsForTesting();
  storeState.setTosAccepted.mockReset();
  storeState.setPrivacyConsent.mockReset();
  storeState.setShareAnalytics.mockReset();
  storeState.setShareDiagnostics.mockReset();
  storeState.setAnalyticsConsentCurrent.mockReset();
  storeState.setDiagnosticsConsentCurrent.mockReset();
  storeState.setConsentHydrated.mockReset();
  patchConsentMock.mockReset();
  patchConsentMock.mockImplementation(async () => {});
  setDeviceBoolMock.mockReset();
});

describe("resolveServerConsent", () => {
  test("reports current toggles when versions match their own version constants", () => {
    const r = resolveServerConsent(makeConsent());
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("a privacy bump leaves the data-capture toggles current (frozen versions)", () => {
    // The toggle versions are frozen at the prior privacy version "2026-06-18".
    // A user who consented under it has stale privacy artifacts after the bump,
    // but their capture-consent stays current and must not be re-prompted.
    const r = resolveServerConsent(
      makeConsent({
        privacy_policy_accepted_version: "2026-06-18",
        ai_data_sharing_accepted_version: "2026-06-18",
        share_analytics_accepted_version: "2026-06-18",
        share_diagnostics_accepted_version: "2026-06-18",
        tos_accepted_version: "2026-06-08",
      }),
    );
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
    expect(r.privacy).toBe(false);
    expect(r.tos).toBe(true);
  });

  test("a record fully at the current versions resolves every axis current", () => {
    const r = resolveServerConsent(makeConsent());
    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("the data-capture toggle fallbacks freeze at the prior privacy version (no re-prompt)", () => {
    // Guards the no-re-prompt guarantee on the fallback path: the frozen
    // constants must stay pinned to the value existing acks were stamped
    // under. A careless future edit that re-points them at the bumped privacy
    // version fails here — genuine bumps arrive via server `required_versions`.
    expect(ANALYTICS_CONSENT_VERSION).toBe("2026-06-18");
    expect(DIAGNOSTICS_CONSENT_VERSION).toBe("2026-06-18");
  });

  test("reports stale toggles for mismatched versions", () => {
    const r = resolveServerConsent(
      makeConsent({
        share_analytics_accepted_version: "2020-01-01",
        share_diagnostics_accepted_version: "2020-01-01",
      }),
    );
    expect(r.analyticsCurrent).toBe(false);
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("null share_analytics (never asked) resolves analytics current — nothing to re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({
        share_analytics: null,
        share_analytics_accepted_version: "",
      }),
    );
    expect(resolved.analyticsCurrent).toBe(true);
  });

  test("an explicit analytics choice under a stale version still requires re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({
        share_analytics: false,
        share_analytics_accepted_version: "2026-01-01",
      }),
    );
    expect(resolved.analyticsCurrent).toBe(false);
  });

  test("null share_diagnostics (never asked) resolves diagnostics current — nothing to re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({
        share_diagnostics: null,
        share_diagnostics_accepted_version: "",
      }),
    );
    expect(resolved.diagnosticsCurrent).toBe(true);
  });

  test("an explicit diagnostics choice under a stale version still requires re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({
        share_diagnostics: false,
        share_diagnostics_accepted_version: "2026-01-01",
      }),
    );
    expect(resolved.diagnosticsCurrent).toBe(false);
  });

  // The implicit-default cases (`true` + empty version resolving to null)
  // are gone: they guarded a pre-nullable platform that materialized its DB
  // default `true` on rows created without the toggle shown. Platform
  // migration 0169 nulled every such implicit ledger row on the single
  // deployment, so that shape no longer exists on the wire — never-asked is
  // exactly `share_analytics === null` now, and any explicit value with an
  // empty version owes a re-review like any other stale explicit choice.

  test("server effective fields are consumed verbatim when present", () => {
    // Never-asked row: raw null stays null (chosen-ness), while the
    // server-computed effective (null = enabled) is surfaced directly.
    const r = resolveServerConsent(
      makeConsent({
        share_analytics: null,
        share_analytics_accepted_version: "",
        share_diagnostics: null,
        share_diagnostics_accepted_version: "",
      }),
    );
    expect(r.shareAnalytics).toBeNull();
    expect(r.shareDiagnostics).toBeNull();
    expect(r.analyticsEffective).toBe(true);
    expect(r.diagnosticsEffective).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("effective fields win over the raw values when they disagree", () => {
    // The platform owns the effective computation; the resolver must not
    // re-derive it from the raw value when the server sent one.
    const r = resolveServerConsent(
      makeConsent({
        share_analytics: true,
        share_analytics_effective: false,
        share_diagnostics: null,
        share_diagnostics_effective: false,
      }),
    );
    expect(r.analyticsEffective).toBe(false);
    expect(r.diagnosticsEffective).toBe(false);
  });

  test("an explicit opt-out resolves effective false and still owes re-review when stale", () => {
    const r = resolveServerConsent(
      makeConsent({
        share_analytics: false,
        share_analytics_accepted_version: "",
        share_diagnostics: false,
        share_diagnostics_accepted_version: "2020-01-01",
      }),
    );
    expect(r.shareAnalytics).toBe(false);
    expect(r.shareDiagnostics).toBe(false);
    expect(r.analyticsEffective).toBe(false);
    expect(r.diagnosticsEffective).toBe(false);
    expect(r.analyticsCurrent).toBe(false);
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("an explicit grant with a version on record resolves the raw values", () => {
    const r = resolveServerConsent(makeConsent());
    expect(r.shareAnalytics).toBe(true);
    expect(r.shareDiagnostics).toBe(true);
  });

  test("reports stale toggles for explicit opt-outs with empty versions", () => {
    // An explicit false is never excused by an empty version — it still
    // owes a re-review.
    const r = resolveServerConsent(
      makeConsent({
        share_analytics: false,
        share_analytics_accepted_version: "",
        share_diagnostics: false,
        share_diagnostics_accepted_version: "",
      }),
    );
    expect(r.analyticsCurrent).toBe(false);
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("reports false for null/undefined consent", () => {
    expect(resolveServerConsent(null).analyticsCurrent).toBe(false);
    expect(resolveServerConsent(null).diagnosticsCurrent).toBe(false);
    expect(resolveServerConsent(undefined).analyticsCurrent).toBe(false);
    expect(resolveServerConsent(undefined).diagnosticsCurrent).toBe(false);
    // No record at all still resolves effective to enabled (opt-out).
    expect(resolveServerConsent(null).analyticsEffective).toBe(true);
    expect(resolveServerConsent(null).diagnosticsEffective).toBe(true);
  });

  // A server version newer than this build's constant counts as current on
  // every axis (currency is monotonic `>=`, not exact equality).
  test("a version NEWER than this build's constant resolves current on every axis", () => {
    const r = resolveServerConsent(
      makeConsent({
        tos_accepted_version: "2099-01-01",
        privacy_policy_accepted_version: "2099-01-01",
        ai_data_sharing_accepted_version: "2099-01-01",
        share_analytics_accepted_version: "2099-01-01",
        share_diagnostics_accepted_version: "2099-01-01",
      }),
    );
    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("privacy needs BOTH artifacts current — a single stale artifact is stale", () => {
    // ai_data_sharing newer than the privacy version, but privacy_policy older.
    expect(
      resolveServerConsent(
        makeConsent({
          privacy_policy_accepted_version: "2020-01-01",
          ai_data_sharing_accepted_version: "2099-01-01",
        }),
      ).privacy,
    ).toBe(false);
    // ...and the mirror case.
    expect(
      resolveServerConsent(
        makeConsent({
          privacy_policy_accepted_version: "2099-01-01",
          ai_data_sharing_accepted_version: "2020-01-01",
        }),
      ).privacy,
    ).toBe(false);
  });

  test("a version OLDER than this build's constant resolves stale", () => {
    const r = resolveServerConsent(
      makeConsent({
        tos_accepted_version: "2020-01-01",
        privacy_policy_accepted_version: "2020-01-01",
        ai_data_sharing_accepted_version: "2020-01-01",
      }),
    );
    expect(r.tos).toBe(false);
    expect(r.privacy).toBe(false);
  });

  test("keeps the existing value/tos/privacy fields", () => {
    const r = resolveServerConsent(makeConsent({ share_analytics: false }));
    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(true);
    expect(r.shareAnalytics).toBe(false);
    expect(r.shareDiagnostics).toBe(true);
  });

  test("tos tracks only the ToS version, independent of the privacy artifacts", () => {
    // A privacy-version bump leaves privacy_policy/ai_data_sharing stale but
    // must NOT mark the standalone ToS checkbox stale.
    const r = resolveServerConsent(
      makeConsent({
        privacy_policy_accepted_version: "2020-01-01",
        ai_data_sharing_accepted_version: "2020-01-01",
      }),
    );
    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(false);
  });

  test("privacy requires BOTH privacy policy and AI data sharing to be current", () => {
    expect(
      resolveServerConsent(
        makeConsent({ ai_data_sharing_accepted_version: "2020-01-01" }),
      ).privacy,
    ).toBe(false);
    expect(
      resolveServerConsent(
        makeConsent({ privacy_policy_accepted_version: "2020-01-01" }),
      ).privacy,
    ).toBe(false);
  });

  test("a stale ToS version does not affect privacy currency", () => {
    const r = resolveServerConsent(
      makeConsent({ tos_accepted_version: "2020-01-01" }),
    );
    expect(r.tos).toBe(false);
    expect(r.privacy).toBe(true);
  });

  test("hasServerRecord is false for an all-defaults response", () => {
    const r = resolveServerConsent(
      makeConsent({
        tos_accepted_version: "",
        privacy_policy_accepted_version: "",
        ai_data_sharing_accepted_version: "",
        share_analytics_accepted_version: "",
        share_diagnostics_accepted_version: "",
        share_analytics: true,
        share_diagnostics: true,
      }),
    );
    expect(r.hasServerRecord).toBe(false);
  });

  test("hasServerRecord is false when share-version fields are omitted", () => {
    // Defensive pin: an absent version field (undefined, not "") must read
    // as "no version on record", never as record evidence.
    const legacy = makeConsent({
      tos_accepted_version: "",
      privacy_policy_accepted_version: "",
      ai_data_sharing_accepted_version: "",
      share_analytics: true,
      share_diagnostics: true,
    }) as unknown as Record<string, unknown>;
    delete legacy.share_analytics_accepted_version;
    delete legacy.share_diagnostics_accepted_version;
    expect(
      resolveServerConsent(legacy as unknown as UserConsent).hasServerRecord,
    ).toBe(false);
  });

  test("hasServerRecord is false for null/undefined consent", () => {
    expect(resolveServerConsent(null).hasServerRecord).toBe(false);
    expect(resolveServerConsent(undefined).hasServerRecord).toBe(false);
  });

  test("hasServerRecord is true when any version is non-empty", () => {
    const allDefaults = {
      tos_accepted_version: "",
      privacy_policy_accepted_version: "",
      ai_data_sharing_accepted_version: "",
      share_analytics_accepted_version: "",
      share_diagnostics_accepted_version: "",
      share_analytics: true,
      share_diagnostics: true,
    };
    expect(
      resolveServerConsent(
        makeConsent({
          ...allDefaults,
          tos_accepted_version: TOS_CONSENT_VERSION,
        }),
      ).hasServerRecord,
    ).toBe(true);
    expect(
      resolveServerConsent(
        makeConsent({
          ...allDefaults,
          ai_data_sharing_accepted_version: PRIVACY_CONSENT_VERSION,
        }),
      ).hasServerRecord,
    ).toBe(true);
  });

  test("hasServerRecord is true when a share boolean is false", () => {
    const allDefaults = {
      tos_accepted_version: "",
      privacy_policy_accepted_version: "",
      ai_data_sharing_accepted_version: "",
      share_analytics_accepted_version: "",
      share_diagnostics_accepted_version: "",
      share_analytics: true,
      share_diagnostics: true,
    };
    expect(
      resolveServerConsent(
        makeConsent({ ...allDefaults, share_analytics: false }),
      ).hasServerRecord,
    ).toBe(true);
    expect(
      resolveServerConsent(
        makeConsent({ ...allDefaults, share_diagnostics: false }),
      ).hasServerRecord,
    ).toBe(true);
  });
});

describe("persistDiagnosticsAck + restoreConsentForUser round-trip", () => {
  test("round-trips the diagnostics ack key (value = acknowledged version)", () => {
    persistDiagnosticsAck("user-1");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
    const r = restoreConsentForUser("user-1");
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("restore reads false while no ack has been stamped", () => {
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
    const r = restoreConsentForUser("user-1");
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("no-ops without a userId", () => {
    persistDiagnosticsAck(null);
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
  });

  test("restore returns false with no userId", () => {
    const r = restoreConsentForUser(null);
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("restore deletes stale analytics ack keys of any version without promoting them", () => {
    // Analytics device acks are dead (analytics is opt-out; no versioned
    // acknowledgment exists) — restore removes them for the current user,
    // whatever version they were stamped under, and leaves other users' keys.
    localStorage.setItem(analyticsKey("user-1"), "true");
    localStorage.setItem(
      "device:consent:share_analytics:v2026-01-01:user-1",
      "true",
    );
    localStorage.setItem(analyticsKey("user-2"), "true");

    restoreConsentForUser("user-1");

    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(
      localStorage.getItem("device:consent:share_analytics:v2026-01-01:user-1"),
    ).toBeNull();
    expect(localStorage.getItem(analyticsKey("user-2"))).toBe("true");
  });

  test("cleans up the legacy 'ai' key without satisfying the current privacy version", () => {
    // A user consented under the old field name at the previous privacy version.
    // The privacy version has since been bumped, so that stale consent must not
    // be promoted as current — the key is cleaned up and privacy stays un-set.
    const legacyAiKey = `device:consent:ai:v2026-06-08:user-1`;
    localStorage.setItem(legacyAiKey, "true");

    const r = restoreConsentForUser("user-1");

    expect(r.privacy).toBe(false);
    // The stale key is removed and privacy is not stamped current.
    expect(localStorage.getItem(legacyAiKey)).toBeNull();
    expect(localStorage.getItem(privacyPolicyAckKey("user-1"))).toBeNull();
    expect(localStorage.getItem(aiDataSharingAckKey("user-1"))).toBeNull();
  });

  test("migrates legacy unversioned ToS but forces privacy re-review", () => {
    // A pre-versioning user with only the legacy active keys. ToS is stamped
    // at the frozen constant — the version the legacy acceptance actually
    // attests — so it migrates as current; the unversioned privacy consent
    // predates the current privacy version, so it must NOT be promoted as
    // current.
    localStorage.setItem("vellum:onboarding:tosAccepted", "true");
    localStorage.setItem("vellum:onboarding:aiDataConsent", "true");

    const r = restoreConsentForUser("user-1");

    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(false);
    // ToS is promoted; privacy is not stamped current.
    expect(localStorage.getItem(tosAckKey("user-1"))).toBe(TOS_CONSENT_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("user-1"))).toBeNull();
    expect(localStorage.getItem(aiDataSharingAckKey("user-1"))).toBeNull();
  });

  test("promotes legacy versioned ack keys to unversioned keys (version becomes the value)", () => {
    // The legacy layout embedded the version in the key over a boolean value.
    // Migration carries the exact attested version into the new key's value
    // and removes every legacy key for the field.
    localStorage.setItem(
      legacyVersionedKey("tos", TOS_CONSENT_VERSION, "user-1"),
      "true",
    );
    localStorage.setItem(
      legacyVersionedKey("privacy", PRIVACY_CONSENT_VERSION, "user-1"),
      "true",
    );
    localStorage.setItem(
      legacyVersionedKey(
        "share_diagnostics",
        DIAGNOSTICS_CONSENT_VERSION,
        "user-1",
      ),
      "true",
    );

    const r = restoreConsentForUser("user-1");

    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
    expect(localStorage.getItem(tosAckKey("user-1"))).toBe(TOS_CONSENT_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("user-1"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );
    expect(localStorage.getItem(aiDataSharingAckKey("user-1"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
    expect(
      localStorage.getItem(
        legacyVersionedKey("tos", TOS_CONSENT_VERSION, "user-1"),
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        legacyVersionedKey("privacy", PRIVACY_CONSENT_VERSION, "user-1"),
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        legacyVersionedKey(
          "share_diagnostics",
          DIAGNOSTICS_CONSENT_VERSION,
          "user-1",
        ),
      ),
    ).toBeNull();
  });

  test("migration promotes the attested version verbatim — an old version reads stale, not current", () => {
    localStorage.setItem(
      legacyVersionedKey("share_diagnostics", "2020-01-01", "user-1"),
      "true",
    );

    const r = restoreConsentForUser("user-1");

    expect(r.diagnosticsCurrent).toBe(false);
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe("2020-01-01");
  });

  test("migration never promotes a false legacy ack, and an existing unversioned key wins", () => {
    // A false legacy key is swept without promotion.
    localStorage.setItem(
      legacyVersionedKey(
        "share_diagnostics",
        DIAGNOSTICS_CONSENT_VERSION,
        "user-1",
      ),
      "false",
    );
    restoreConsentForUser("user-1");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();

    // Once an unversioned ack exists, a lingering legacy key can't overwrite it.
    localStorage.setItem(diagnosticsKey("user-1"), "2099-01-01");
    localStorage.setItem(
      legacyVersionedKey(
        "share_diagnostics",
        DIAGNOSTICS_CONSENT_VERSION,
        "user-1",
      ),
      "true",
    );
    restoreConsentForUser("user-1");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe("2099-01-01");
    expect(
      localStorage.getItem(
        legacyVersionedKey(
          "share_diagnostics",
          DIAGNOSTICS_CONSENT_VERSION,
          "user-1",
        ),
      ),
    ).toBeNull();
  });
});

describe("saveConsent", () => {
  test("stamps both toggle versions in the patch body", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: false,
      hasPlatformSession: true,
    });
    expect(patchConsentMock).toHaveBeenCalledTimes(1);
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_analytics_accepted_version).toBe(
      ANALYTICS_CONSENT_VERSION,
    );
    expect(body.share_diagnostics_accepted_version).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
  });

  test("ToS stamps the ToS version; the privacy checkbox stamps privacy policy + AI data sharing", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: false,
      shareAnalytics: true,
      shareDiagnostics: true,
      hasPlatformSession: true,
    });
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.tos_accepted_version).toBe(TOS_CONSENT_VERSION);
    // privacy=false clears both privacy artifacts together.
    expect(body.privacy_policy_accepted_version).toBe("");
    expect(body.ai_data_sharing_accepted_version).toBe("");
  });

  test("the privacy checkbox stamps both privacy policy and AI data sharing versions", () => {
    saveConsent({
      userId: "user-1",
      tos: false,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      hasPlatformSession: true,
    });
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.tos_accepted_version).toBe("");
    expect(body.privacy_policy_accepted_version).toBe(PRIVACY_CONSENT_VERSION);
    expect(body.ai_data_sharing_accepted_version).toBe(PRIVACY_CONSENT_VERSION);
  });

  test("sets both currency flags and writes the diagnostics ack key only", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      hasPlatformSession: false,
    });
    expect(storeState.setAnalyticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setDiagnosticsConsentCurrent).toHaveBeenCalledWith(true);
    // Analytics has no device ack — its version stamp is server-side only.
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
  });

  test("null shareAnalytics (toggle not shown) omits analytics from the patch and skips its ack", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: true,
      hasPlatformSession: true,
    });
    const body = patchConsentMock.mock.calls[0][0];
    expect("share_analytics" in body).toBe(false);
    expect("share_analytics_accepted_version" in body).toBe(false);
    expect(body.share_diagnostics).toBe(true);
    expect(body.share_diagnostics_accepted_version).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
    expect(storeState.setShareAnalytics).not.toHaveBeenCalled();
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe(null);
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
    // Never-asked has nothing to re-review — must not bounce to review-terms.
    expect(storeState.setAnalyticsConsentCurrent).toHaveBeenCalledWith(true);
  });

  test("null shareDiagnostics (toggle not shown) omits diagnostics from the patch, skips its ack, and keeps the gate open", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: null,
      hasPlatformSession: true,
    });
    const body = patchConsentMock.mock.calls[0][0];
    expect("share_diagnostics" in body).toBe(false);
    expect("share_diagnostics_accepted_version" in body).toBe(false);
    expect(storeState.setShareDiagnostics).not.toHaveBeenCalled();
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(null);
    // Never-asked has nothing to re-review — must not bounce to review-terms.
    expect(storeState.setDiagnosticsConsentCurrent).toHaveBeenCalledWith(true);
    // Null must not touch the gate: an explicit device opt-out survives
    // flows that don't show the toggle (a never-written gate reads open by
    // default via the opt-out read fallback).
    const gateWrites = setDeviceBoolMock.mock.calls.filter(
      (call) => call[0] === "diagnosticsReporting",
    );
    expect(gateWrites).toEqual([]);
  });

  test("explicit shareDiagnostics=true opens the reporting gate", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: true,
      hasPlatformSession: false,
    });
    expect(setDeviceBoolMock).toHaveBeenCalledWith(
      "diagnosticsReporting",
      true,
    );
  });

  test("explicit shareDiagnostics=false persists the opt-out and closes the reporting gate", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: false,
      hasPlatformSession: true,
    });
    expect(setDeviceBoolMock).toHaveBeenCalledWith(
      "diagnosticsReporting",
      false,
    );
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_diagnostics).toBe(false);
    expect(body.share_diagnostics_accepted_version).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
  });

  test("marks consent hydrated — an explicit acceptance is authoritative", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      hasPlatformSession: false,
    });
    expect(storeState.setConsentHydrated).toHaveBeenCalledWith(true);
  });
});

describe("savePreferenceToggle", () => {
  test("stamps the analytics version server-side and sets its flag only (no device ack)", () => {
    savePreferenceToggle("share_analytics", true, {
      userId: "user-1",
      hasPlatformSession: true,
    });
    expect(storeState.setShareAnalytics).toHaveBeenCalledWith(true);
    expect(storeState.setAnalyticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setDiagnosticsConsentCurrent).not.toHaveBeenCalled();
    // Analytics has no device ack key; the version stamp lives server-side.
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_analytics).toBe(true);
    expect(body.share_analytics_accepted_version).toBe(
      ANALYTICS_CONSENT_VERSION,
    );
  });

  test("stamps the diagnostics version and sets its flag only", () => {
    savePreferenceToggle("share_diagnostics", false, {
      userId: "user-1",
      hasPlatformSession: true,
    });
    expect(storeState.setDiagnosticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setAnalyticsConsentCurrent).not.toHaveBeenCalled();
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_diagnostics).toBe(false);
    expect(body.share_diagnostics_accepted_version).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
  });

  test("offline persists the on/off value but skips the currency stamp, ack key, and server patch", () => {
    savePreferenceToggle("share_analytics", true, {
      userId: "user-1",
      hasPlatformSession: false,
    });
    // The chosen value is still recorded (the store setter persists the
    // device key)...
    expect(storeState.setShareAnalytics).toHaveBeenCalledWith(true);
    // ...but no version-currency is stamped without a session to record against.
    expect(storeState.setAnalyticsConsentCurrent).not.toHaveBeenCalled();
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(patchConsentMock).not.toHaveBeenCalled();
  });

  test("an offline diagnostics opt-out still closes the reporting gate (opt-out follows the preference)", () => {
    savePreferenceToggle("share_diagnostics", false, {
      userId: "user-1",
      hasPlatformSession: false,
    });
    expect(storeState.setShareDiagnostics).toHaveBeenCalledWith(false);
    expect(setDeviceBoolMock).toHaveBeenCalledWith(
      "diagnosticsReporting",
      false,
    );
    expect(storeState.setDiagnosticsConsentCurrent).not.toHaveBeenCalled();
    expect(patchConsentMock).not.toHaveBeenCalled();
  });

  test("an offline diagnostics opt-in opens the reporting gate", () => {
    savePreferenceToggle("share_diagnostics", true, {
      userId: "user-1",
      hasPlatformSession: false,
    });
    expect(setDeviceBoolMock).toHaveBeenCalledWith(
      "diagnosticsReporting",
      true,
    );
  });
});

describe("clearConsentForUser", () => {
  test("clears the ack keys, legacy versioned keys, and stale analytics ack keys", () => {
    persistDiagnosticsAck("user-1");
    localStorage.setItem(tosAckKey("user-1"), TOS_CONSENT_VERSION);
    localStorage.setItem(
      privacyPolicyAckKey("user-1"),
      PRIVACY_CONSENT_VERSION,
    );
    localStorage.setItem(
      aiDataSharingAckKey("user-1"),
      PRIVACY_CONSENT_VERSION,
    );
    localStorage.setItem(analyticsKey("user-1"), "true");
    localStorage.setItem(
      legacyVersionedKey("tos", TOS_CONSENT_VERSION, "user-1"),
      "true",
    );
    clearConsentForUser("user-1");
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
    expect(localStorage.getItem(tosAckKey("user-1"))).toBeNull();
    expect(localStorage.getItem(privacyPolicyAckKey("user-1"))).toBeNull();
    expect(localStorage.getItem(aiDataSharingAckKey("user-1"))).toBeNull();
    expect(
      localStorage.getItem(
        legacyVersionedKey("tos", TOS_CONSENT_VERSION, "user-1"),
      ),
    ).toBeNull();
  });
});

describe("server-supplied required versions", () => {
  test("required_versions newer than the accepted versions owes re-review on every axis", () => {
    const r = resolveServerConsent(
      makeConsent({ required_versions: BUMPED_REQUIRED_VERSIONS }),
    );
    expect(r.tos).toBe(false);
    expect(r.privacy).toBe(false);
    // Explicit choices on record are stale against the bumped requirement.
    expect(r.analyticsCurrent).toBe(false);
    expect(r.diagnosticsCurrent).toBe(false);
    expect(r.analyticsVersionCurrent).toBe(false);
    expect(r.diagnosticsVersionCurrent).toBe(false);
  });

  test("accepted versions at the bumped requirement resolve current", () => {
    const r = resolveServerConsent(
      makeConsent({
        required_versions: BUMPED_REQUIRED_VERSIONS,
        tos_accepted_version: BUMPED_VERSION,
        privacy_policy_accepted_version: BUMPED_VERSION,
        ai_data_sharing_accepted_version: BUMPED_VERSION,
        share_analytics_accepted_version: BUMPED_VERSION,
        share_diagnostics_accepted_version: BUMPED_VERSION,
      }),
    );
    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("an empty required_versions map falls back per-key to the constants (empty-value guard)", () => {
    const r = resolveServerConsent(makeConsent({ required_versions: {} }));
    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("each privacy artifact compares against its own required version", () => {
    // Only the AI data sharing requirement is bumped: the privacy checkbox
    // (covering both artifacts) goes stale while every other axis stays
    // current.
    const r = resolveServerConsent(
      makeConsent({
        required_versions: {
          tos: TOS_CONSENT_VERSION,
          privacy_policy: PRIVACY_CONSENT_VERSION,
          ai_data_sharing: BUMPED_VERSION,
          share_analytics: ANALYTICS_CONSENT_VERSION,
          share_diagnostics: DIAGNOSTICS_CONSENT_VERSION,
        },
      }),
    );
    expect(r.privacy).toBe(false);
    expect(r.tos).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("missing keys inside required_versions fall back per-key to the constants", () => {
    const r = resolveServerConsent(
      makeConsent({ required_versions: { tos: BUMPED_VERSION } }),
    );
    expect(r.tos).toBe(false);
    expect(r.privacy).toBe(true);
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("PATCH bodies and device acks stamp the server-supplied required versions", () => {
    resolveServerConsent(
      makeConsent({ required_versions: BUMPED_REQUIRED_VERSIONS }),
    );
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      hasPlatformSession: true,
    });
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.tos_accepted_version).toBe(BUMPED_VERSION);
    expect(body.privacy_policy_accepted_version).toBe(BUMPED_VERSION);
    expect(body.ai_data_sharing_accepted_version).toBe(BUMPED_VERSION);
    expect(body.share_analytics_accepted_version).toBe(BUMPED_VERSION);
    expect(body.share_diagnostics_accepted_version).toBe(BUMPED_VERSION);
    expect(localStorage.getItem(tosAckKey("user-1"))).toBe(BUMPED_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("user-1"))).toBe(
      BUMPED_VERSION,
    );
    expect(localStorage.getItem(aiDataSharingAckKey("user-1"))).toBe(
      BUMPED_VERSION,
    );
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(BUMPED_VERSION);
  });

  test("privacy artifacts version independently — an ai_data_sharing bump is not masked by a newer privacy_policy ack", () => {
    // Accept while privacy_policy requires a NEWER version than
    // ai_data_sharing. Each artifact ack stores its own version — a single
    // collapsed max would attest ai_data_sharing versions the user never saw.
    resolveServerConsent(
      makeConsent({
        required_versions: {
          tos: "2026-06-08",
          privacy_policy: "2026-08-01",
          ai_data_sharing: "2026-06-22",
          share_analytics: "2026-06-18",
          share_diagnostics: "2026-06-18",
        },
      }),
    );
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: null,
      hasPlatformSession: false,
    });
    expect(localStorage.getItem(privacyPolicyAckKey("user-1"))).toBe(
      "2026-08-01",
    );
    expect(localStorage.getItem(aiDataSharingAckKey("user-1"))).toBe(
      "2026-06-22",
    );
    expect(restoreConsentForUser("user-1").privacy).toBe(true);

    // ai_data_sharing bumps to a version still BELOW the stored
    // privacy_policy ack — the checkbox must go stale anyway.
    resolveServerConsent(
      makeConsent({
        required_versions: {
          tos: "2026-06-08",
          privacy_policy: "2026-08-01",
          ai_data_sharing: "2026-07-01",
          share_analytics: "2026-06-18",
          share_diagnostics: "2026-06-18",
        },
      }),
    );
    expect(restoreConsentForUser("user-1").privacy).toBe(false);
  });

  test("device acks stamped under the constants read stale once the server bumps", () => {
    // Acks earned while the module still ran on the constants fallback...
    saveConsent({
      userId: "user-1",
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: true,
      hasPlatformSession: false,
    });
    expect(restoreConsentForUser("user-1")).toEqual({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    // ...owe a re-review after a resolve adopts bumped requirements.
    resolveServerConsent(
      makeConsent({ required_versions: BUMPED_REQUIRED_VERSIONS }),
    );
    expect(restoreConsentForUser("user-1")).toEqual({
      tos: false,
      privacy: false,
      diagnosticsCurrent: false,
    });
  });

  test("a later resolve with empty required_versions restores the constants for stamps", () => {
    resolveServerConsent(
      makeConsent({ required_versions: BUMPED_REQUIRED_VERSIONS }),
    );
    resolveServerConsent(makeConsent({ required_versions: {} }));
    savePreferenceToggle("share_diagnostics", true, {
      userId: "user-1",
      hasPlatformSession: true,
    });
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_diagnostics_accepted_version).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe(
      DIAGNOSTICS_CONSENT_VERSION,
    );
  });
});
