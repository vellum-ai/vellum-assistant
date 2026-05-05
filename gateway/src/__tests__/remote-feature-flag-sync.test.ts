import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CredentialCache } from "../credential-cache.js";

// ---------------------------------------------------------------------------
// Isolated temp directory (mirrors feature-flags-route.test.ts pattern)
// ---------------------------------------------------------------------------
import { testSecurityDir } from "./test-preload.js";

const protectedDir = testSecurityDir;

// ---------------------------------------------------------------------------
// Mock fetchImpl
// ---------------------------------------------------------------------------
type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mock.module)
// ---------------------------------------------------------------------------
const { RemoteFeatureFlagSync } =
  await import("../remote-feature-flag-sync.js");
const { readRemoteFeatureFlags, clearRemoteFeatureFlagStoreCache } =
  await import("../feature-flag-remote-store.js");
const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("../feature-flag-defaults.js");

// ---------------------------------------------------------------------------
// Test-local registry with a GA flag (defaultEnabled: true) for the
// "ignores remote false for GA flags" test. Written to an isolated temp path
// so we never touch the committed registry file.
// ---------------------------------------------------------------------------
const testRegistryPath = join(protectedDir, "feature-flag-registry.json");

const TEST_REGISTRY = {
  version: 1,
  flags: [
    {
      id: "test-ga-flag",
      scope: "assistant",
      key: "test-ga-flag",
      label: "Test GA Flag",
      description: "A test flag that is GA (defaultEnabled: true)",
      defaultEnabled: true,
    },
    {
      id: "email-channel",
      scope: "assistant",
      key: "email-channel",
      label: "Email Channel",
      description: "Email channel integration",
      defaultEnabled: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeCredentialCacheExt = CredentialCache & {
  _invalidate(): void;
  _setValues(v: Record<string, string | undefined>): void;
};

/**
 * Build a fake CredentialCache that resolves credential keys from an
 * in-memory map. Keys follow the `credential/{service}/{field}` format
 * produced by `credentialKey()`.
 *
 * Includes `onInvalidate` support and test helpers:
 * - `_invalidate()` — fire all registered invalidation listeners
 * - `_setValues(v)` — replace the in-memory credential map
 */
function fakeCredentialCache(
  initialValues: Record<string, string | undefined> = {},
): FakeCredentialCacheExt {
  let values = { ...initialValues };
  const invalidateListeners = new Set<() => void>();
  return {
    get: async (key: string) => values[key],
    onInvalidate: (cb: () => void) => {
      invalidateListeners.add(cb);
      return () => {
        invalidateListeners.delete(cb);
      };
    },
    _invalidate: () => {
      for (const cb of invalidateListeners) cb();
    },
    _setValues: (v: Record<string, string | undefined>) => {
      values = { ...v };
    },
  } as unknown as FakeCredentialCacheExt;
}

function defaultCredentials(): Record<string, string> {
  return {
    "credential/vellum/platform_base_url": "https://platform.vellum.ai",
    "credential/vellum/assistant_api_key": "test-api-key",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const savedVellumPlatformUrl = process.env.VELLUM_PLATFORM_URL;
const savedAssistantCredential = process.env.ASSISTANT_API_KEY;

beforeEach(() => {
  // Clear env vars that the production code falls back to, so tests remain
  // deterministic unless they explicitly set them.
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.ASSISTANT_API_KEY;
  mkdirSync(protectedDir, { recursive: true });
  // Write the test registry and point resolution at it
  writeFileSync(testRegistryPath, JSON.stringify(TEST_REGISTRY, null, 2));
  _setRegistryCandidateOverrides([testRegistryPath]);
  resetFeatureFlagDefaultsCache();
  clearRemoteFeatureFlagStoreCache();
  fetchMock = mock(async () => new Response());
});

afterEach(() => {
  // Restore env vars
  const restoreEnv = (key: string, saved: string | undefined): void => {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  };
  restoreEnv("VELLUM_PLATFORM_URL", savedVellumPlatformUrl);
  restoreEnv("ASSISTANT_API_KEY", savedAssistantCredential);
  try {
    rmSync(protectedDir, { recursive: true, force: true });
    mkdirSync(protectedDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
  _setRegistryCandidateOverrides(null);
  resetFeatureFlagDefaultsCache();
  clearRemoteFeatureFlagStoreCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("RemoteFeatureFlagSync", () => {
  test("skips sync when no platform URL is available from cache or env", async () => {
    fetchMock = mock(async () => Response.json({ flags: { ff1: true } }));

    const creds = defaultCredentials();
    delete creds["credential/vellum/platform_base_url"];
    delete process.env.VELLUM_PLATFORM_URL;

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    // No fetch calls — sync is skipped when platform URL is unavailable
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls back to VELLUM_PLATFORM_URL env var when platform_base_url is missing", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));
    process.env.VELLUM_PLATFORM_URL = "https://env-platform.example.com";

    const creds = defaultCredentials();
    delete creds["credential/vellum/platform_base_url"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://env-platform.example.com/v1/feature-flags/assistant-flag-values/",
    );
  });

  test("skips sync when assistant_api_key is missing", async () => {
    const creds = defaultCredentials();
    delete creds["credential/vellum/assistant_api_key"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("syncs when only platformUrl and assistantApiKey are present", async () => {
    fetchMock = mock(async () => Response.json({ flags: { ff1: true } }));

    const creds = {
      "credential/vellum/platform_base_url": "https://platform.example.com",
      "credential/vellum/assistant_api_key": "test-api-key",
    };

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to ASSISTANT_API_KEY env var when credential key is missing", async () => {
    fetchMock = mock(async () => Response.json({ flags: { ff1: true } }));
    process.env.ASSISTANT_API_KEY = "env-key";

    const creds = {
      "credential/vellum/platform_base_url": "https://platform.example.com",
    };

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Api-Key env-key");
  });

  test("fetches and caches flags on successful response", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: { browser: true },
      }),
    );

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({ browser: true });
  });

  test("preserves cached flags on non-OK response", async () => {
    // First, seed cached flags with a successful fetch
    fetchMock = mock(async () =>
      Response.json({
        flags: { browser: true },
      }),
    );

    const sync1 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync1.start();
    sync1.stop();

    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({
      browser: true,
    });

    // Now simulate a non-OK response — cached flags should be preserved
    fetchMock = mock(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const sync2 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync2.start();
    sync2.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({ browser: true });
  });

  test("preserves cached flags on network error", async () => {
    // First, seed cached flags with a successful fetch
    fetchMock = mock(async () =>
      Response.json({
        flags: { browser: true },
      }),
    );

    const sync1 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync1.start();
    sync1.stop();

    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({
      browser: true,
    });

    // Now simulate a network error — cached flags should be preserved
    fetchMock = mock(async () => {
      throw new Error("Network failure");
    });

    const sync2 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    // Should not throw — errors are caught and logged
    await sync2.start();
    sync2.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({ browser: true });
  });

  test("sends correct auth header", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const apiKey = "my-secret-key-42";
    const creds = {
      ...defaultCredentials(),
      "credential/vellum/assistant_api_key": apiKey,
    };
    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Api-Key ${apiKey}`);
  });

  test("constructs correct URL from platform base URL", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const creds = {
      ...defaultCredentials(),
      "credential/vellum/platform_base_url": "https://platform.example.com",
    };
    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://platform.example.com/v1/feature-flags/assistant-flag-values/",
    );
  });

  test("filters non-boolean values from response", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          browser: true,
          contacts: "yes" as unknown,
          other: 1 as unknown,
          valid: false,
        },
      }),
    );

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync.start();
    sync.stop();

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({
      browser: true,
      valid: false,
    });
  });

  test("preserves cached flags when response is missing flags field", async () => {
    // First, seed cached flags with a successful fetch
    fetchMock = mock(async () =>
      Response.json({
        flags: { browser: true },
      }),
    );

    const sync1 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync1.start();
    sync1.stop();

    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({
      browser: true,
    });

    // Now simulate a response with missing flags field — cached flags should be preserved
    fetchMock = mock(async () => Response.json({ data: "unexpected" }));

    const sync2 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync2.start();
    sync2.stop();

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({ browser: true });
  });

  test("strips trailing slashes from platform URL", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const creds = {
      ...defaultCredentials(),
      "credential/vellum/platform_base_url": "https://platform.example.com///",
    };
    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://platform.example.com/v1/feature-flags/assistant-flag-values/",
    );
  });

  test("ignores remote false for GA flags (defaultEnabled: true in registry)", async () => {
    // The platform sends false for all flags it knows about (blanket-deny).
    // GA flags (defaultEnabled: true in the registry) should not be disabled
    // by remote overrides — only local persisted overrides can do that.
    // Uses the test-local registry which defines test-ga-flag as GA
    // (defaultEnabled: true) and email-channel as gated (defaultEnabled: false).
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          // GA flag (defaultEnabled: true) — remote false should be dropped
          "test-ga-flag": false,
          // Gated flag (defaultEnabled: false) — remote false is kept
          "email-channel": false,
          // GA flag set to true — should be kept (redundant but harmless)
          "test-ga-flag-true": true,
          // Unknown flag — remote false is kept (not in registry)
          "unknown-flag": false,
        },
      }),
    );

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync.start();
    sync.stop();

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    // test-ga-flag (GA, remote false) should be absent
    expect(cached["test-ga-flag"]).toBeUndefined();
    // email-channel (gated, remote false) should be present
    expect(cached["email-channel"]).toBe(false);
    // test-ga-flag-true (unknown but true) should be present
    expect(cached["test-ga-flag-true"]).toBe(true);
    // unknown-flag (not in registry, remote false) should be present
    expect(cached["unknown-flag"]).toBe(false);
  });

  test("trims whitespace from credential values", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const creds = {
      "credential/vellum/platform_base_url": "  https://platform.example.com  ",
      "credential/vellum/assistant_api_key": "  trimmed-key  ",
    };
    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://platform.example.com/v1/feature-flags/assistant-flag-values/",
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Api-Key trimmed-key");
  });

  test("polls with backoff when initial fetch fails, then snaps to steady-state on success", async () => {
    // Simulate: first two fetches return 500, third succeeds.
    let fetchCallCount = 0;
    fetchMock = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount <= 2) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return Response.json({ flags: { "backoff-flag": true } });
    });

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // Initial fetch failed (500) — 1 call so far
    expect(fetchCallCount).toBe(1);

    // Wait for first poll (50ms) — still fails (500)
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchCallCount).toBe(2);

    // Wait for second poll (100ms = 50ms doubled) — succeeds
    await new Promise((r) => setTimeout(r, 130));
    expect(fetchCallCount).toBe(3);

    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "backoff-flag": true });

    sync.stop();
  });

  test("snaps to steady-state interval immediately when initial fetch succeeds", async () => {
    fetchMock = mock(async () => Response.json({ flags: { "ok-flag": true } }));

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // Initial fetch succeeded — 1 call
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Wait past what would be the initial poll interval — should NOT poll
    // again because the interval snapped to steady-state (5 min)
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sync.stop();
  });

  test("syncNow during in-flight poll does not create duplicate poll chains", async () => {
    // Simulate a slow fetch that takes 200ms to resolve.
    let fetchCallCount = 0;
    fetchMock = mock(async () => {
      fetchCallCount++;
      await new Promise((r) => setTimeout(r, 200));
      return Response.json({ flags: { ok: true } });
    });

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      initialPollIntervalMs: 50,
    });
    await sync.start();
    // start() awaits its own fetchAndCache, so fetchCallCount is 1 now.
    expect(fetchCallCount).toBe(1);

    // Wait for the first poll timer to fire (50ms would be initial, but
    // start succeeded so it snapped to steady-state). Instead, we'll
    // call syncNow() directly — the interesting case is when poll() is
    // already in-flight. To trigger that, we use a short interval.
    sync.stop();

    // Reset with short interval to create the race:
    fetchCallCount = 0;
    fetchMock = mock(async () => {
      fetchCallCount++;
      // Slow fetch — 150ms
      await new Promise((r) => setTimeout(r, 150));
      return Response.json({ flags: { ok: true } });
    });

    const sync2 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      initialPollIntervalMs: 30,
    });
    await sync2.start(); // 1 fetch (slow, 150ms)
    expect(fetchCallCount).toBe(1);

    // Wait for poll timer to fire and start its fetch (30ms after start)
    await new Promise((r) => setTimeout(r, 50));
    // poll() has fired and its fetchAndCache() is now in-flight

    // Call syncNow() while poll's fetch is in-flight
    const syncNowPromise = sync2.syncNow();

    // Wait for everything to settle
    await syncNowPromise;
    await new Promise((r) => setTimeout(r, 300));

    // Count how many fetches happened after the race window
    const fetchesDuringRace = fetchCallCount;

    // Now wait a bit more — if duplicate poll chains exist, we'd see
    // extra fetches firing at the short interval
    await new Promise((r) => setTimeout(r, 200));

    // Should NOT have extra fetches from a leaked poll chain
    // At most: 1 (start) + 1 (poll) + 1 (syncNow) + 1 (next scheduled poll)
    expect(fetchCallCount).toBeLessThanOrEqual(fetchesDuringRace + 1);

    sync2.stop();
  });

  test("doubles poll interval on consecutive failures", async () => {
    // Always fail with 500
    fetchMock = mock(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // Initial fetch failed (500) — 1 call
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After 50ms: first poll fires, still fails → interval doubles to 100ms
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // After another 100ms: second poll fires, still fails → interval doubles to 200ms
    await new Promise((r) => setTimeout(r, 130));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // After another 200ms: third poll fires
    await new Promise((r) => setTimeout(r, 230));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    sync.stop();
  });

  test("pauses polling when credentials are missing and resumes on invalidation", async () => {
    fetchMock = mock(async () =>
      Response.json({ flags: { "resumed-flag": true } }),
    );

    const creds = fakeCredentialCache({
      ...defaultCredentials(),
      "credential/vellum/assistant_api_key": undefined,
    });

    const sync = new RemoteFeatureFlagSync({
      credentials: creds,
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // No fetch calls — missing creds, polling should be paused
    expect(fetchMock).not.toHaveBeenCalled();

    // Wait well past the initial poll interval — should still not poll
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).not.toHaveBeenCalled();

    // Simulate user logging in — credentials now available
    creds._setValues(defaultCredentials());
    creds._invalidate();

    // Wait for syncNow to complete (async, fire-and-forget from callback)
    await new Promise((r) => setTimeout(r, 50));

    // Should have fetched once after credential invalidation
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "resumed-flag": true });

    sync.stop();
  });
});
