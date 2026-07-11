import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../__tests__/helpers/set-config.js";
import type { OwnerConsent } from "./client.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockClient: {
  platformAssistantId: string;
  getOwnerConsent: () => Promise<OwnerConsent | null>;
} | null = null;
let createCallCount = 0;

// ---------------------------------------------------------------------------
// Module mocks (must precede the import under test)
// ---------------------------------------------------------------------------

mock.module("./client.js", () => ({
  VellumPlatformClient: {
    create: async () => {
      createCallCount += 1;
      return mockClient;
    },
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  __setCachedShareAnalyticsForTest,
  __setCachedShareDiagnosticsForTest,
  __setCachedShareDiagnosticsVersionForTest,
  getCachedShareAnalytics,
  getCachedShareDiagnostics,
  getCachedShareDiagnosticsVersion,
  refreshConsentCache,
  startConsentRefresh,
  stopConsentRefresh,
} from "./consent-cache.js";

/**
 * Build a mock owner consent. Fields default to `false` so existing
 * share_analytics-focused cases don't have to spell them out.
 */
function makeConsent(overrides: Partial<OwnerConsent> = {}): OwnerConsent {
  return {
    shareAnalytics: false,
    shareDiagnostics: false,
    shareDiagnosticsAcceptedVersion: "",
    ...overrides,
  };
}

function makeClient(consent: OwnerConsent | null, assistantId = "asst_1") {
  return {
    platformAssistantId: assistantId,
    getOwnerConsent: async () => consent,
  };
}

describe("consent-cache", () => {
  beforeEach(() => {
    mockClient = null;
    createCallCount = 0;
    // Legacy fail-closed opt-out marker read via getConfigReadOnly(). Default
    // off so existing behavior is unchanged.
    setConfig("legacyTelemetryOptOut", false);
    __setCachedShareAnalyticsForTest(false);
    __setCachedShareDiagnosticsForTest(false);
    __setCachedShareDiagnosticsVersionForTest("");
  });

  afterEach(async () => {
    await stopConsentRefresh();
  });

  test("defaults to false before any refresh", () => {
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("stays false when no platform client is available", async () => {
    mockClient = null;
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("becomes true after a successful fetch reporting shareAnalytics: true", async () => {
    mockClient = makeClient(makeConsent({ shareAnalytics: true }));
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(true);
  });

  test("a null fetch keeps the last known value", async () => {
    mockClient = makeClient(makeConsent({ shareAnalytics: true }));
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(true);

    // Transient failure: consent endpoint returns null.
    mockClient = makeClient(null);
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(true);
  });

  test("a missing client flips a prior opt-in back to false", async () => {
    __setCachedShareAnalyticsForTest(true);
    mockClient = null;
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("a client without a resolvable assistant identity fails closed", async () => {
    __setCachedShareAnalyticsForTest(true);
    // Identity cleared mid-session (e.g. assistantId emptied while base URL +
    // API key persist). getOwnerConsent must not be relied upon to preserve the
    // prior opt-in here — fail closed instead.
    mockClient = makeClient(makeConsent({ shareAnalytics: true }), "");
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("legacy opt-out marker keeps analytics off despite platform opt-in", async () => {
    setConfig("legacyTelemetryOptOut", true);
    mockClient = makeClient(makeConsent({ shareAnalytics: true }));
    await refreshConsentCache();
    // Platform reports opt-in, but the fail-closed marker forces off.
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("a fetch reporting shareAnalytics: false turns the cache off", async () => {
    __setCachedShareAnalyticsForTest(true);
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("startConsentRefresh is idempotent and runs an immediate refresh", async () => {
    mockClient = makeClient(makeConsent({ shareAnalytics: true }));

    startConsentRefresh();
    startConsentRefresh(); // no-op: timer already running
    // Let the fire-and-forget immediate refresh settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCachedShareAnalytics()).toBe(true);
    // One immediate refresh from the first call; the second is a no-op.
    expect(createCallCount).toBe(1);
  });

  test("stopConsentRefresh clears the timer (start can run again)", async () => {
    startConsentRefresh();
    await stopConsentRefresh();
    // A fresh start after stop performs another immediate refresh.
    mockClient = makeClient(makeConsent({ shareAnalytics: true }));
    startConsentRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedShareAnalytics()).toBe(true);
  });

  // share_diagnostics tracks the same refresh as share_analytics; Sentry's
  // beforeSend re-reads it per event so a revocation is honored within a cycle.
  test("diagnostics defaults to false before any refresh", () => {
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("diagnostics becomes true after a fetch reporting shareDiagnostics: true", async () => {
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);
  });

  test("a later fetch reporting shareDiagnostics: false honors the revocation", async () => {
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);

    mockClient = makeClient(makeConsent({ shareDiagnostics: false }));
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("a null diagnostics fetch keeps the last known value", async () => {
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);

    mockClient = makeClient(null);
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);
  });

  test("a missing client flips a prior diagnostics opt-in back to false", async () => {
    __setCachedShareDiagnosticsForTest(true);
    mockClient = null;
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("a client without a resolvable assistant identity fails diagnostics closed", async () => {
    __setCachedShareDiagnosticsForTest(true);
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }), "");
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("caches the accepted diagnostics-consent version from a successful fetch", async () => {
    mockClient = makeClient(
      makeConsent({
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      }),
    );
    await refreshConsentCache();
    expect(getCachedShareDiagnosticsVersion()).toBe("2026-06-18");
  });

  test("a missing client clears a prior cached diagnostics version", async () => {
    __setCachedShareDiagnosticsVersionForTest("2026-06-18");
    mockClient = null;
    await refreshConsentCache();
    expect(getCachedShareDiagnosticsVersion()).toBe("");
  });

  test("a client without a resolvable assistant identity clears the diagnostics version", async () => {
    __setCachedShareDiagnosticsVersionForTest("2026-06-18");
    mockClient = makeClient(
      makeConsent({
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      }),
      "",
    );
    await refreshConsentCache();
    expect(getCachedShareDiagnosticsVersion()).toBe("");
  });

  test("a null fetch keeps the last known diagnostics version", async () => {
    mockClient = makeClient(
      makeConsent({
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      }),
    );
    await refreshConsentCache();
    expect(getCachedShareDiagnosticsVersion()).toBe("2026-06-18");

    mockClient = makeClient(null);
    await refreshConsentCache();
    expect(getCachedShareDiagnosticsVersion()).toBe("2026-06-18");
  });
});
