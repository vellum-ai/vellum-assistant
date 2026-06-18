import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OwnerConsent } from "./client.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockClient: {
  platformAssistantId: string;
  getOwnerConsent: () => Promise<OwnerConsent | null>;
} | null = null;
let createCallCount = 0;
// Legacy fail-closed opt-out marker surfaced via getConfigReadOnly(). Default
// off/absent so existing behavior is unchanged.
let mockLegacyTelemetryOptOut: boolean | undefined = false;

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

mock.module("../config/loader.js", () => ({
  getConfigReadOnly: () => ({
    legacyTelemetryOptOut: mockLegacyTelemetryOptOut,
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  __resetConsentResolutionForTest,
  __setCachedShareAnalyticsForTest,
  getCachedShareAnalytics,
  onConsentResolved,
  refreshConsentCache,
  startConsentRefresh,
  stopConsentRefresh,
} from "./consent-cache.js";

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
    mockLegacyTelemetryOptOut = false;
    __setCachedShareAnalyticsForTest(false);
    __resetConsentResolutionForTest();
  });

  afterEach(async () => {
    await stopConsentRefresh();
    __resetConsentResolutionForTest();
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
    mockClient = makeClient({ shareAnalytics: true, shareDiagnostics: false });
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(true);
  });

  test("a null fetch keeps the last known value", async () => {
    mockClient = makeClient({ shareAnalytics: true, shareDiagnostics: false });
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
    mockClient = makeClient(
      { shareAnalytics: true, shareDiagnostics: false },
      "",
    );
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("legacy opt-out marker keeps analytics off despite platform opt-in", async () => {
    mockLegacyTelemetryOptOut = true;
    mockClient = makeClient({ shareAnalytics: true, shareDiagnostics: false });
    await refreshConsentCache();
    // Platform reports opt-in, but the fail-closed marker forces off.
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("a fetch reporting shareAnalytics: false turns the cache off", async () => {
    __setCachedShareAnalyticsForTest(true);
    mockClient = makeClient({ shareAnalytics: false, shareDiagnostics: true });
    await refreshConsentCache();
    expect(getCachedShareAnalytics()).toBe(false);
  });

  test("startConsentRefresh is idempotent and runs an immediate refresh", async () => {
    mockClient = makeClient({ shareAnalytics: true, shareDiagnostics: false });

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
    mockClient = makeClient({ shareAnalytics: true, shareDiagnostics: false });
    startConsentRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedShareAnalytics()).toBe(true);
  });
});

describe("onConsentResolved", () => {
  beforeEach(() => {
    mockClient = null;
    createCallCount = 0;
    mockLegacyTelemetryOptOut = false;
    __setCachedShareAnalyticsForTest(false);
    __resetConsentResolutionForTest();
  });

  afterEach(async () => {
    await stopConsentRefresh();
    __resetConsentResolutionForTest();
  });

  function setConsent(consent: OwnerConsent | null) {
    mockClient = makeClient(consent);
  }

  test("fires once on the first successful fetch with the resolved consent", async () => {
    const consent: OwnerConsent = {
      shareAnalytics: true,
      shareDiagnostics: false,
    };
    const received: OwnerConsent[] = [];
    onConsentResolved((c) => received.push(c));

    setConsent(consent);
    await refreshConsentCache();

    expect(received).toEqual([consent]);
  });

  test("does not fire again on a second successful fetch (one-shot)", async () => {
    let calls = 0;
    onConsentResolved(() => {
      calls += 1;
    });

    setConsent({ shareAnalytics: true, shareDiagnostics: false });
    await refreshConsentCache();
    setConsent({ shareAnalytics: false, shareDiagnostics: true });
    await refreshConsentCache();

    expect(calls).toBe(1);
  });

  test("a listener registered after resolution fires immediately with the last consent", async () => {
    const consent: OwnerConsent = {
      shareAnalytics: false,
      shareDiagnostics: true,
    };
    setConsent(consent);
    await refreshConsentCache();

    const received: OwnerConsent[] = [];
    onConsentResolved((c) => received.push(c));

    expect(received).toEqual([consent]);
  });

  test("a null fetch never fires; a later successful fetch does", async () => {
    const received: OwnerConsent[] = [];
    onConsentResolved((c) => received.push(c));

    setConsent(null);
    await refreshConsentCache();
    expect(received).toEqual([]);

    const consent: OwnerConsent = {
      shareAnalytics: true,
      shareDiagnostics: true,
    };
    setConsent(consent);
    await refreshConsentCache();

    expect(received).toEqual([consent]);
  });
});
