/**
 * Tests for the visibility/focus diagnostics-consent refresh.
 *
 * `fetchConsent`, the diagnostics chokepoint, and both stores are mocked so the
 * refresh trigger logic is observable without a server, DOM storage, or Sentry.
 * `resolveServerConsent` runs for real — it's a pure mapping over the fetched
 * record, so asserting what reaches the chokepoint exercises the real shape.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import type { UserConsent } from "@/domains/account/profile";

let consentResult: Promise<UserConsent>;
const fetchConsent = mock(() => consentResult);
// `mock.module` is process-global and replaces the whole module, so re-export
// `patchConsent` (imported transitively by onboarding-cleanup).
mock.module("@/domains/account/profile", () => ({
  fetchConsent,
  patchConsent: mock(() => Promise.resolve()),
}));

// The refresh floor reads a module-level timestamp; advance the fake clock far
// past the floor on each test so a prior test's refresh can't debounce the next.
let clock = new Date("2026-06-18T00:00:00Z").getTime();
const FLOOR_CLEAR_MS = 5 * 60_000;

type Resolved = {
  shareDiagnostics: boolean | null;
  diagnosticsVersionCurrent: boolean;
  hasServerRecord: boolean;
};
const applyResolvedDiagnosticsConsent = mock(
  (_resolved: Resolved, _set: (v: boolean) => void): boolean | null => null,
);
mock.module("@/lib/consent/diagnostics-consent", () => ({
  applyResolvedDiagnosticsConsent,
  setDiagnosticsReportingGate: mock(() => {}),
}));

let currentUser: { id: string } | null = { id: "u1" };
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: currentUser }) },
}));

const setShareDiagnostics = mock((_v: boolean) => {});
mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: { getState: () => ({ setShareDiagnostics }) },
}));

const { DIAGNOSTICS_CONSENT_VERSION } = await import("@/utils/onboarding-cleanup");
const { refreshDiagnosticsConsent, installConsentRefreshListeners } =
  await import("./consent-refresh");

function consentRecord(overrides: Partial<UserConsent> = {}): UserConsent {
  return {
    tos_accepted_version: "",
    tos_accepted_at: null,
    privacy_policy_accepted_version: "",
    privacy_policy_accepted_at: null,
    ai_data_sharing_accepted_version: "",
    ai_data_sharing_accepted_at: null,
    share_analytics: true,
    share_diagnostics: true,
    share_analytics_accepted_version: "",
    share_analytics_accepted_at: null,
    share_diagnostics_accepted_version: "",
    share_diagnostics_accepted_at: null,
    ...overrides,
  };
}

/** A confident, current revoke (real record, share off, version current). */
function revokeRecord(): UserConsent {
  return consentRecord({
    share_diagnostics: false,
    share_diagnostics_accepted_version: DIAGNOSTICS_CONSENT_VERSION,
  });
}

beforeEach(() => {
  fetchConsent.mockClear();
  applyResolvedDiagnosticsConsent.mockClear();
  setShareDiagnostics.mockClear();
  currentUser = { id: "u1" };
  consentResult = Promise.resolve(consentRecord());
  clock += FLOOR_CLEAR_MS;
  setSystemTime(new Date(clock));
});

afterEach(() => {
  setSystemTime();
});

/** Yield to the microtask queue so the fetch promise settles. */
const flush = (): Promise<void> => Promise.resolve();

describe("refreshDiagnosticsConsent", () => {
  test("no-ops when unauthenticated", async () => {
    currentUser = null;
    await refreshDiagnosticsConsent();
    expect(fetchConsent).not.toHaveBeenCalled();
    expect(applyResolvedDiagnosticsConsent).not.toHaveBeenCalled();
  });

  test("routes a confirmed revoke through the chokepoint", async () => {
    consentResult = Promise.resolve(revokeRecord());
    await refreshDiagnosticsConsent();
    expect(applyResolvedDiagnosticsConsent).toHaveBeenCalledTimes(1);
    const resolved = applyResolvedDiagnosticsConsent.mock.calls[0]![0];
    expect(resolved).toMatchObject({
      shareDiagnostics: false,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });
  });

  test("swallows a thrown fetch and leaves state unchanged", async () => {
    consentResult = Promise.reject(new Error("offline"));
    await refreshDiagnosticsConsent();
    expect(applyResolvedDiagnosticsConsent).not.toHaveBeenCalled();
  });

  test("leaves state unchanged for an empty server record", async () => {
    // Default consentRecord() has empty accepted-version fields →
    // hasServerRecord=false. A device-confirmed opted-in user whose server
    // record is missing (backfill pending/failed) must NOT have the gate closed
    // by a refresh — only the auth resync applies the device fallback.
    consentResult = Promise.resolve(consentRecord());
    await refreshDiagnosticsConsent();
    expect(fetchConsent).toHaveBeenCalledTimes(1);
    expect(applyResolvedDiagnosticsConsent).not.toHaveBeenCalled();
  });
});

describe("installConsentRefreshListeners", () => {
  test("a visible visibilitychange triggers a refresh", async () => {
    const cleanup = installConsentRefreshListeners();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchConsent).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("a window focus triggers a refresh", async () => {
    const cleanup = installConsentRefreshListeners();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchConsent).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("the 60s floor coalesces rapid focus events", async () => {
    const cleanup = installConsentRefreshListeners();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchConsent).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("refreshes again once the 60s floor has elapsed", async () => {
    const cleanup = installConsentRefreshListeners();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchConsent).toHaveBeenCalledTimes(1);

    setSystemTime(new Date(clock + 61_000));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchConsent).toHaveBeenCalledTimes(2);
    cleanup();
  });

  test("cleanup removes listeners so later events do not refresh", async () => {
    const cleanup = installConsentRefreshListeners();
    cleanup();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchConsent).not.toHaveBeenCalled();
  });
});
