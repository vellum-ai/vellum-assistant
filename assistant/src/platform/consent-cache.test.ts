import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OwnerConsent } from "./client.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockClient: { getOwnerConsent: () => Promise<OwnerConsent | null> } | null =
  null;
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
  __setCachedShareAnalyticsForTest,
  getCachedShareAnalytics,
  refreshConsentCache,
  startConsentRefresh,
  stopConsentRefresh,
} from "./consent-cache.js";

function makeClient(consent: OwnerConsent | null) {
  return { getOwnerConsent: async () => consent };
}

describe("consent-cache", () => {
  beforeEach(() => {
    mockClient = null;
    createCallCount = 0;
    __setCachedShareAnalyticsForTest(false);
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
