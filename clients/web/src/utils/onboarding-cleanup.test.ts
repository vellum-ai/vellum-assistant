/**
 * Tests for the versioned share-toggle consent layer in `onboarding-cleanup`.
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
  setShareDiagnostics: mock(() => {}),
  setAnalyticsConsentCurrent: mock(() => {}),
  setDiagnosticsConsentCurrent: mock(() => {}),
  setConsentHydrated: mock(() => {}),
};
mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: { getState: () => storeState },
}));

// `onboarding-cleanup` only needs `patchConsent`; the real `profile` module
// pulls in the generated API client (unavailable in unit tests), so stub it.
const patchConsentMock = mock(async (_consent: ConsentPatch) => {});
mock.module("@/domains/account/profile", () => ({
  patchConsent: patchConsentMock,
}));
mock.module("@/generated/api/client.gen", () => ({ client: {} }));

const setDeviceBoolMock = mock((_name: string, _value: boolean) => {});
mock.module("@/utils/device-settings", () => ({
  setDeviceBool: setDeviceBoolMock,
}));

import {
  TOS_CONSENT_VERSION,
  PRIVACY_CONSENT_VERSION,
  ANALYTICS_CONSENT_VERSION,
  DIAGNOSTICS_CONSENT_VERSION,
  clearConsentForUser,
  persistToggleConsent,
  resolveServerConsent,
  restoreConsentForUser,
  saveConsent,
  savePreferenceToggle,
} from "@/utils/onboarding-cleanup";
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

const analyticsKey = (userId: string) =>
  `device:consent:share_analytics:v${ANALYTICS_CONSENT_VERSION}:${userId}`;
const diagnosticsKey = (userId: string) =>
  `device:consent:share_diagnostics:v${DIAGNOSTICS_CONSENT_VERSION}:${userId}`;

beforeEach(() => {
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

  test("the data-capture toggles freeze at the prior privacy version (no re-prompt)", () => {
    // Guards the no-re-prompt guarantee: the toggle versions must stay pinned to
    // the value existing acks/device keys were stamped under. A careless future
    // edit that re-points them at the bumped privacy version fails here.
    expect(ANALYTICS_CONSENT_VERSION).toBe("2026-06-18");
    expect(DIAGNOSTICS_CONSENT_VERSION).toBe("2026-06-18");
    expect(analyticsKey("user-1")).toBe(
      "device:consent:share_analytics:v2026-06-18:user-1",
    );
    expect(diagnosticsKey("user-1")).toBe(
      "device:consent:share_diagnostics:v2026-06-18:user-1",
    );
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
      makeConsent({ share_analytics: null, share_analytics_accepted_version: "" }),
    );
    expect(resolved.analyticsCurrent).toBe(true);
  });

  test("an explicit analytics choice under a stale version still requires re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({ share_analytics: false, share_analytics_accepted_version: "2026-01-01" }),
    );
    expect(resolved.analyticsCurrent).toBe(false);
  });

  test("null share_diagnostics (never asked) resolves diagnostics current — nothing to re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({ share_diagnostics: null, share_diagnostics_accepted_version: "" }),
    );
    expect(resolved.diagnosticsCurrent).toBe(true);
  });

  test("an explicit diagnostics choice under a stale version still requires re-review", () => {
    const resolved = resolveServerConsent(
      makeConsent({ share_diagnostics: false, share_diagnostics_accepted_version: "2026-01-01" }),
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

  test("absent effective fields (older backend) fall back to the raw values' opt-out reading", () => {
    const legacy = (overrides: Partial<UserConsent>) => {
      const consent = makeConsent(overrides) as unknown as Record<string, unknown>;
      delete consent.share_analytics_effective;
      delete consent.share_diagnostics_effective;
      return consent as unknown as UserConsent;
    };
    // Explicit values pass through...
    const explicit = resolveServerConsent(
      legacy({ share_analytics: false, share_diagnostics: true }),
    );
    expect(explicit.analyticsEffective).toBe(false);
    expect(explicit.diagnosticsEffective).toBe(true);
    // ...and never-asked defaults to enabled (opt-out semantics).
    const neverAsked = resolveServerConsent(
      legacy({ share_analytics: null, share_diagnostics: null }),
    );
    expect(neverAsked.analyticsEffective).toBe(true);
    expect(neverAsked.diagnosticsEffective).toBe(true);
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

  test("hasServerRecord is false when share-version fields are omitted (older backend)", () => {
    // Simulate a rollout-window response that predates the share-version
    // fields: they are absent (undefined), not empty strings.
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
        makeConsent({ ...allDefaults, tos_accepted_version: TOS_CONSENT_VERSION }),
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

describe("persistToggleConsent + restoreConsentForUser round-trip", () => {
  test("round-trips both ack keys", () => {
    persistToggleConsent("user-1", { analyticsCurrent: true, diagnosticsCurrent: true });
    const r = restoreConsentForUser("user-1");
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
  });

  test("only writes the provided field", () => {
    persistToggleConsent("user-1", { analyticsCurrent: true });
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe("true");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
    const r = restoreConsentForUser("user-1");
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("no-ops without a userId", () => {
    persistToggleConsent(null, { analyticsCurrent: true });
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
  });

  test("restore returns false for both with no userId", () => {
    const r = restoreConsentForUser(null);
    expect(r.analyticsCurrent).toBe(false);
    expect(r.diagnosticsCurrent).toBe(false);
  });

  test("cleans up the legacy 'ai' key without satisfying the current privacy version", () => {
    // A user consented under the old field name at the previous privacy version.
    // The privacy version has since been bumped, so that stale consent must not
    // be promoted as current — the key is cleaned up and privacy stays un-set.
    const legacyAiKey = `device:consent:ai:v2026-06-08:user-1`;
    const privacyKey = `device:consent:privacy:v${PRIVACY_CONSENT_VERSION}:user-1`;
    localStorage.setItem(legacyAiKey, "true");

    const r = restoreConsentForUser("user-1");

    expect(r.privacy).toBe(false);
    // The stale key is removed and privacy is not stamped current.
    expect(localStorage.getItem(legacyAiKey)).toBeNull();
    expect(localStorage.getItem(privacyKey)).toBeNull();
  });

  test("migrates legacy unversioned ToS but forces privacy re-review", () => {
    // A pre-versioning user with only the legacy active keys. ToS is unchanged
    // so it migrates as current; the unversioned privacy consent predates the
    // current privacy version, so it must NOT be promoted as current.
    localStorage.setItem("vellum:onboarding:tosAccepted", "true");
    localStorage.setItem("vellum:onboarding:aiDataConsent", "true");
    const privacyKey = `device:consent:privacy:v${PRIVACY_CONSENT_VERSION}:user-1`;
    const tosKey = `device:consent:tos:v${TOS_CONSENT_VERSION}:user-1`;

    const r = restoreConsentForUser("user-1");

    expect(r.tos).toBe(true);
    expect(r.privacy).toBe(false);
    // ToS is promoted; privacy is not stamped current.
    expect(localStorage.getItem(tosKey)).toBe("true");
    expect(localStorage.getItem(privacyKey)).toBe("false");
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
    expect(body.share_analytics_accepted_version).toBe(ANALYTICS_CONSENT_VERSION);
    expect(body.share_diagnostics_accepted_version).toBe(DIAGNOSTICS_CONSENT_VERSION);
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

  test("sets both currency flags and writes both ack keys", () => {
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
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe("true");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe("true");
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
    expect(body.share_diagnostics_accepted_version).toBe(DIAGNOSTICS_CONSENT_VERSION);
    expect(storeState.setShareAnalytics).not.toHaveBeenCalled();
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe(null);
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe("true");
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
    expect(setDeviceBoolMock).toHaveBeenCalledWith("diagnosticsReporting", true);
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
    expect(setDeviceBoolMock).toHaveBeenCalledWith("diagnosticsReporting", false);
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_diagnostics).toBe(false);
    expect(body.share_diagnostics_accepted_version).toBe(DIAGNOSTICS_CONSENT_VERSION);
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe("true");
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
  test("stamps the analytics version and sets its flag only", () => {
    savePreferenceToggle("share_analytics", true, { userId: "user-1", hasPlatformSession: true });
    expect(storeState.setAnalyticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setDiagnosticsConsentCurrent).not.toHaveBeenCalled();
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe("true");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_analytics).toBe(true);
    expect(body.share_analytics_accepted_version).toBe(ANALYTICS_CONSENT_VERSION);
  });

  test("stamps the diagnostics version and sets its flag only", () => {
    savePreferenceToggle("share_diagnostics", false, { userId: "user-1", hasPlatformSession: true });
    expect(storeState.setDiagnosticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setAnalyticsConsentCurrent).not.toHaveBeenCalled();
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_diagnostics).toBe(false);
    expect(body.share_diagnostics_accepted_version).toBe(DIAGNOSTICS_CONSENT_VERSION);
  });

  test("offline persists the on/off value but skips the currency stamp, ack key, and server patch", () => {
    savePreferenceToggle("share_analytics", true, { userId: "user-1", hasPlatformSession: false });
    // The chosen value is still recorded device-locally...
    expect(storeState.setShareAnalytics).toHaveBeenCalledWith(true);
    expect(setDeviceBoolMock).toHaveBeenCalledWith("shareAnalytics", true);
    // ...but no version-currency is stamped without a session to record against.
    expect(storeState.setAnalyticsConsentCurrent).not.toHaveBeenCalled();
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(patchConsentMock).not.toHaveBeenCalled();
  });

  test("an offline diagnostics opt-out still closes the reporting gate (opt-out follows the preference)", () => {
    savePreferenceToggle("share_diagnostics", false, { userId: "user-1", hasPlatformSession: false });
    expect(setDeviceBoolMock).toHaveBeenCalledWith("shareDiagnostics", false);
    expect(setDeviceBoolMock).toHaveBeenCalledWith("diagnosticsReporting", false);
    expect(storeState.setDiagnosticsConsentCurrent).not.toHaveBeenCalled();
    expect(patchConsentMock).not.toHaveBeenCalled();
  });

  test("an offline diagnostics opt-in opens the reporting gate", () => {
    savePreferenceToggle("share_diagnostics", true, { userId: "user-1", hasPlatformSession: false });
    expect(setDeviceBoolMock).toHaveBeenCalledWith("diagnosticsReporting", true);
  });
});

describe("clearConsentForUser", () => {
  test("clears both toggle ack keys", () => {
    persistToggleConsent("user-1", { analyticsCurrent: true, diagnosticsCurrent: true });
    clearConsentForUser("user-1");
    expect(localStorage.getItem(analyticsKey("user-1"))).toBeNull();
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
  });
});
