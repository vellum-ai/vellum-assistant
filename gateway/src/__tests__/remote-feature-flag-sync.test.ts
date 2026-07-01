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
const { resetEnvOverridesCache } =
  await import("../feature-flag-env-overrides.js");

// ---------------------------------------------------------------------------
// Test-local registry with a GA flag (defaultEnabled: true) for the
// "normalizes remote false for GA flags" test. Written to an isolated temp path
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
      id: "a2a-channel",
      scope: "assistant",
      key: "a2a-channel",
      label: "A2A Channel",
      description: "A2A channel integration",
      defaultEnabled: false,
    },
    {
      // Real GA-normalization-exempt flag (defaultEnabled: true, but listed in
      // GA_NORMALIZATION_EXEMPT_FLAGS) — a platform-sent false must be honored,
      // not rewritten to true, so its managed rollout can be staged in LD.
      id: "messages-search-backend",
      scope: "assistant",
      key: "messages-search-backend",
      label: "Messages Search Backend",
      description: "Messages search backend (qdrant default; staged rollout)",
      defaultEnabled: true,
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
const savedDisablePlatform = process.env.VELLUM_DISABLE_PLATFORM;

beforeEach(() => {
  // Clear env vars that the production code falls back to, so tests remain
  // deterministic unless they explicitly set them.
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.ASSISTANT_API_KEY;
  delete process.env.VELLUM_DISABLE_PLATFORM;
  mkdirSync(protectedDir, { recursive: true });
  // Write the test registry and point resolution at it
  writeFileSync(testRegistryPath, JSON.stringify(TEST_REGISTRY, null, 2));
  _setRegistryCandidateOverrides([testRegistryPath]);
  resetFeatureFlagDefaultsCache();
  resetEnvOverridesCache();
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
  restoreEnv("VELLUM_DISABLE_PLATFORM", savedDisablePlatform);
  try {
    rmSync(protectedDir, { recursive: true, force: true });
    mkdirSync(protectedDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
  _setRegistryCandidateOverrides(null);
  resetFeatureFlagDefaultsCache();
  resetEnvOverridesCache();
  clearRemoteFeatureFlagStoreCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("RemoteFeatureFlagSync", () => {
  test("skips sync when platform features are disabled", async () => {
    fetchMock = mock(async () => Response.json({ flags: { ff1: true } }));
    process.env.VELLUM_DISABLE_PLATFORM = "true";

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  test("fetches without auth header when assistant_api_key is missing", async () => {
    fetchMock = mock(async () => Response.json({ flags: { ff1: true } }));

    const creds = defaultCredentials();
    delete creds["credential/vellum/assistant_api_key"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe("application/json");
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

  test("syncNow re-fetches with current credentials after an identity change (warm-pool claim)", async () => {
    // Regression for JARVIS-1018: a warm-pool pod that already synced flags
    // for a previous identity gets reassigned to a new assistant. The
    // credential-change wiring in index.ts calls syncNow(); it must re-fetch
    // with the NEW api key and overwrite the cached per-assistant flag values
    // immediately, rather than serving the previous identity's (or registry
    // default) values until the next ~5-min poll.
    const cache = fakeCredentialCache({
      "credential/vellum/platform_base_url": "https://platform.example.com",
      "credential/vellum/assistant_api_key": "old-assistant-key",
    });

    // Previous identity: self-intro-greeting OFF.
    fetchMock = mock(async () =>
      Response.json({ flags: { "self-intro-greeting": false } }),
    );

    const sync = new RemoteFeatureFlagSync({ credentials: cache });
    await sync.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "self-intro-greeting": false });

    // Warm-pool claim: credentials now belong to the newly-assigned assistant,
    // whose flag evaluation returns self-intro-greeting ON.
    cache._setValues({
      "credential/vellum/platform_base_url": "https://platform.example.com",
      "credential/vellum/assistant_api_key": "new-assistant-key",
    });
    fetchMock = mock(async () =>
      Response.json({ flags: { "self-intro-greeting": true } }),
    );

    await sync.syncNow();
    sync.stop();

    // Re-fetched immediately, authenticated as the new identity...
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Api-Key new-assistant-key");

    // ...and the cached value now reflects the new assistant.
    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "self-intro-greeting": true });
  });

  test("syncNow coalesces a follow-up fetch when an identity change lands mid-sync", async () => {
    // JARVIS-1018 hardening: during a warm-pool claim several credential files
    // are written in quick succession, each firing the change handler's
    // syncNow(). The first fetch may be authenticated with a stale key; a
    // second syncNow() arriving while it is in flight must NOT be dropped by
    // the re-entrancy guard — it must trigger one more fetch so the final
    // identity's flags are cached, not the stale ones.
    const cache = fakeCredentialCache({
      "credential/vellum/platform_base_url": "https://platform.example.com",
      "credential/vellum/assistant_api_key": "old-assistant-key",
    });

    let fetchCount = 0;
    const seenKeys: string[] = [];
    fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
      fetchCount++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers.Authorization ?? "");
      // Slow fetch so the second syncNow lands while the first is in flight.
      await new Promise((r) => setTimeout(r, 100));
      const isNew = headers.Authorization === "Api-Key new-assistant-key";
      return Response.json({ flags: { "self-intro-greeting": isNew } });
    });

    const sync = new RemoteFeatureFlagSync({ credentials: cache });
    await sync.start(); // initial fetch with the old key
    // Reset counters so we only measure the overlapping-syncNow window.
    fetchCount = 0;
    seenKeys.length = 0;

    // First syncNow starts a slow fetch authenticated with the old key.
    const first = sync.syncNow();
    await new Promise((r) => setTimeout(r, 20)); // let that fetch begin

    // Warm-pool claim: identity changes, then a second syncNow arrives while
    // the first fetch is still in flight.
    cache._setValues({
      "credential/vellum/platform_base_url": "https://platform.example.com",
      "credential/vellum/assistant_api_key": "new-assistant-key",
    });
    await sync.syncNow(); // returns immediately, records pendingResync
    await first; // first loop settles, then runs the coalesced follow-up
    sync.stop();

    // Two fetches: the original (old key) plus the coalesced follow-up (new key).
    expect(fetchCount).toBe(2);
    expect(seenKeys[0]).toBe("Api-Key old-assistant-key");
    expect(seenKeys[1]).toBe("Api-Key new-assistant-key");

    // Final cached value reflects the new identity, not the stale fetch.
    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "self-intro-greeting": true });
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

  test("accepts boolean and string values, filters other types from response", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          browser: true,
          "default-model": "claude-sonnet-4-6",
          other: 1 as unknown,
          valid: false,
          nullVal: null as unknown,
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
      "default-model": "claude-sonnet-4-6",
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

  test("normalizes remote false for GA flags (defaultEnabled: true in registry)", async () => {
    // The platform sends false for all flags it knows about (blanket-deny).
    // GA flags (defaultEnabled: true in the registry) should not be disabled
    // by remote overrides — only local persisted overrides can do that.
    // Uses the test-local registry which defines test-ga-flag as GA
    // (defaultEnabled: true) and a2a-channel as gated (defaultEnabled: false).
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          // GA flag (defaultEnabled: true) — remote false should be normalized
          // to true so the missing-key fallback does not disable it.
          "test-ga-flag": false,
          // Gated flag (defaultEnabled: false) — remote false is kept
          "a2a-channel": false,
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
    // test-ga-flag (GA, remote false) should be normalized to true
    expect(cached["test-ga-flag"]).toBe(true);
    // a2a-channel (gated, remote false) should be present
    expect(cached["a2a-channel"]).toBe(false);
    // test-ga-flag-true (unknown but true) should be present
    expect(cached["test-ga-flag-true"]).toBe(true);
    // unknown-flag (not in registry, remote false) should be present
    expect(cached["unknown-flag"]).toBe(false);
  });

  test("preserves remote false for GA-normalization-exempt flags (staged rollout)", async () => {
    // messages-search-backend defaults on (defaultEnabled: true) but is listed
    // in GA_NORMALIZATION_EXEMPT_FLAGS. The platform's blanket-deny false must
    // pass through unchanged so managed assistants stay off until LaunchDarkly
    // targeting flips them on — unlike a normal GA flag, whose false is rewritten
    // to true.
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          // Exempt flag (defaultEnabled: true) — remote false is KEPT.
          "messages-search-backend": false,
          // Ordinary GA flag (defaultEnabled: true) — remote false normalized to true.
          "test-ga-flag": false,
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
    // Exempt flag: platform false is honored (not normalized to true).
    expect(cached["messages-search-backend"]).toBe(false);
    // Non-exempt GA flag: platform false is still normalized to true.
    expect(cached["test-ga-flag"]).toBe(true);
  });

  test("GA normalization does not affect string flag values", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          "test-ga-flag": false,
          "a2a-channel": "custom-value",
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
    // Boolean false for GA flag is normalized to true
    expect(cached["test-ga-flag"]).toBe(true);
    // String values are never subject to GA normalization
    expect(cached["a2a-channel"]).toBe("custom-value");
  });

  test("calls onChanged when remote flags change", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: { "new-flag": true },
      }),
    );

    const onChanged = mock(() => {});
    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      onChanged,
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("does not call onChanged when remote flags have not changed", async () => {
    // First sync to seed the file
    fetchMock = mock(async () =>
      Response.json({
        flags: { "stable-flag": true },
      }),
    );

    const onChanged1 = mock(() => {});
    const sync1 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      onChanged: onChanged1,
    });
    await sync1.start();
    sync1.stop();
    expect(onChanged1).toHaveBeenCalledTimes(1);

    // Second sync with same data — onChanged should NOT fire
    fetchMock = mock(async () =>
      Response.json({
        flags: { "stable-flag": true },
      }),
    );

    const onChanged2 = mock(() => {});
    const sync2 = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      onChanged: onChanged2,
    });
    await sync2.start();
    sync2.stop();
    expect(onChanged2).not.toHaveBeenCalled();
  });

  test("does not call onChanged on fetch failure", async () => {
    fetchMock = mock(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const onChanged = mock(() => {});
    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(defaultCredentials()),
      onChanged,
    });
    await sync.start();
    sync.stop();

    expect(onChanged).not.toHaveBeenCalled();
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

  test("pauses polling when platform URL is missing and resumes on invalidation", async () => {
    fetchMock = mock(async () =>
      Response.json({ flags: { "resumed-flag": true } }),
    );

    const creds = fakeCredentialCache({
      "credential/vellum/assistant_api_key": "test-api-key",
    });

    const sync = new RemoteFeatureFlagSync({
      credentials: creds,
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // No fetch calls — missing platform URL, polling should be paused
    expect(fetchMock).not.toHaveBeenCalled();

    // Wait well past the initial poll interval — should still not poll
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).not.toHaveBeenCalled();

    // Simulate platform URL becoming available
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

  test("does not downgrade to anonymous fetch when API key is transiently lost", async () => {
    const cache = fakeCredentialCache(defaultCredentials());

    // Initial authenticated fetch succeeds
    fetchMock = mock(async () =>
      Response.json({ flags: { "per-assistant-flag": true } }),
    );

    const sync = new RemoteFeatureFlagSync({
      credentials: cache,
      initialPollIntervalMs: 50,
    });
    await sync.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "per-assistant-flag": true });

    // Simulate transient API key loss (CES hiccup) — platform URL still present
    cache._setValues({
      "credential/vellum/platform_base_url": "https://platform.vellum.ai",
    });
    fetchMock = mock(async () =>
      Response.json({ flags: { "per-assistant-flag": false } }),
    );

    await sync.syncNow();

    // Should NOT have fetched — transient key loss triggers error/backoff,
    // not an anonymous fetch that would overwrite per-assistant values.
    expect(fetchMock).not.toHaveBeenCalled();

    // Cached values from the previous authenticated fetch are preserved.
    clearRemoteFeatureFlagStoreCache();
    expect(readRemoteFeatureFlags()).toEqual({ "per-assistant-flag": true });

    sync.stop();
  });
});
