/**
 * Tests for the versioned share-toggle consent layer in `onboarding-cleanup`.
 *
 * Collaborators (`onboarding-store`, `auth-store`, `profile.patchConsent`,
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
  setAiDataConsent: mock(() => {}),
  setShareAnalytics: mock(() => {}),
  setShareDiagnostics: mock(() => {}),
  setAnalyticsConsentCurrent: mock(() => {}),
  setDiagnosticsConsentCurrent: mock(() => {}),
};
mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: { getState: () => storeState },
}));

let authUserId: string | null = "user-1";
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: authUserId ? { id: authUserId } : null }) },
}));

// `onboarding-cleanup` only needs `patchConsent`; the real `profile` module
// pulls in the generated API client (unavailable in unit tests), so stub it.
const patchConsentMock = mock(async (_consent: ConsentPatch) => {});
mock.module("@/domains/account/profile", () => ({
  patchConsent: patchConsentMock,
}));
mock.module("@/generated/api/client.gen", () => ({ client: {} }));

const setDeviceBoolMock = mock(() => {});
mock.module("@/utils/device-settings", () => ({
  setDeviceBool: setDeviceBoolMock,
}));

import {
  CONSENT_VERSION,
  clearConsentForUser,
  persistToggleConsent,
  resolveServerConsent,
  restoreConsentForUser,
  saveConsent,
  savePreferenceToggle,
} from "@/utils/onboarding-cleanup";
import type { UserConsent } from "@/domains/account/profile";

function makeConsent(overrides: Partial<UserConsent> = {}): UserConsent {
  return {
    tos_accepted_version: CONSENT_VERSION,
    tos_accepted_at: null,
    privacy_policy_accepted_version: CONSENT_VERSION,
    privacy_policy_accepted_at: null,
    ai_data_sharing_accepted_version: CONSENT_VERSION,
    ai_data_sharing_accepted_at: null,
    share_analytics: true,
    share_diagnostics: true,
    share_analytics_accepted_version: CONSENT_VERSION,
    share_analytics_accepted_at: null,
    share_diagnostics_accepted_version: CONSENT_VERSION,
    share_diagnostics_accepted_at: null,
    ...overrides,
  };
}

const analyticsKey = (userId: string) =>
  `device:consent:share_analytics:v${CONSENT_VERSION}:${userId}`;
const diagnosticsKey = (userId: string) =>
  `device:consent:share_diagnostics:v${CONSENT_VERSION}:${userId}`;

beforeEach(() => {
  authUserId = "user-1";
  storeState.setTosAccepted.mockReset();
  storeState.setAiDataConsent.mockReset();
  storeState.setShareAnalytics.mockReset();
  storeState.setShareDiagnostics.mockReset();
  storeState.setAnalyticsConsentCurrent.mockReset();
  storeState.setDiagnosticsConsentCurrent.mockReset();
  patchConsentMock.mockReset();
  patchConsentMock.mockImplementation(async () => {});
  setDeviceBoolMock.mockReset();
});

describe("resolveServerConsent", () => {
  test("reports current toggles when versions match CONSENT_VERSION", () => {
    const r = resolveServerConsent(makeConsent());
    expect(r.analyticsCurrent).toBe(true);
    expect(r.diagnosticsCurrent).toBe(true);
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

  test("reports stale toggles for empty versions", () => {
    const r = resolveServerConsent(
      makeConsent({
        share_analytics_accepted_version: "",
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
  });

  test("keeps the existing value/tos/ai fields", () => {
    const r = resolveServerConsent(makeConsent({ share_analytics: false }));
    expect(r.tos).toBe(true);
    expect(r.ai).toBe(true);
    expect(r.shareAnalytics).toBe(false);
    expect(r.shareDiagnostics).toBe(true);
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
});

describe("saveConsent", () => {
  test("stamps both toggle versions in the patch body", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      ai: true,
      shareAnalytics: true,
      shareDiagnostics: false,
      hasPlatformSession: true,
    });
    expect(patchConsentMock).toHaveBeenCalledTimes(1);
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_analytics_accepted_version).toBe(CONSENT_VERSION);
    expect(body.share_diagnostics_accepted_version).toBe(CONSENT_VERSION);
  });

  test("sets both currency flags and writes both ack keys", () => {
    saveConsent({
      userId: "user-1",
      tos: true,
      ai: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      hasPlatformSession: false,
    });
    expect(storeState.setAnalyticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setDiagnosticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe("true");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBe("true");
  });
});

describe("savePreferenceToggle", () => {
  test("stamps the analytics version and sets its flag only", () => {
    savePreferenceToggle("share_analytics", true, true);
    expect(storeState.setAnalyticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setDiagnosticsConsentCurrent).not.toHaveBeenCalled();
    expect(localStorage.getItem(analyticsKey("user-1"))).toBe("true");
    expect(localStorage.getItem(diagnosticsKey("user-1"))).toBeNull();
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_analytics).toBe(true);
    expect(body.share_analytics_accepted_version).toBe(CONSENT_VERSION);
  });

  test("stamps the diagnostics version and sets its flag only", () => {
    savePreferenceToggle("share_diagnostics", false, true);
    expect(storeState.setDiagnosticsConsentCurrent).toHaveBeenCalledWith(true);
    expect(storeState.setAnalyticsConsentCurrent).not.toHaveBeenCalled();
    const body = patchConsentMock.mock.calls[0][0];
    expect(body.share_diagnostics).toBe(false);
    expect(body.share_diagnostics_accepted_version).toBe(CONSENT_VERSION);
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
