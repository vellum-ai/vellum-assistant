import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import type { CredentialCache } from "../credential-cache.js";

// ---------------------------------------------------------------------------
// Isolated temp directory (mirrors feature-flags-route.test.ts pattern)
// ---------------------------------------------------------------------------
const testDir = join(
  tmpdir(),
  `vellum-remote-ff-sync-test-${randomBytes(6).toString("hex")}`,
);
const vellumRoot = join(testDir, ".vellum");
const protectedDir = join(vellumRoot, "protected");

const savedBaseDataDir = process.env.BASE_DATA_DIR;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake CredentialCache that resolves credential keys from an
 * in-memory map. Keys follow the `credential/{service}/{field}` format
 * produced by `credentialKey()`.
 */
function fakeCredentialCache(
  values: Record<string, string | undefined> = {},
): CredentialCache {
  return {
    get: async (key: string) => values[key],
  } as unknown as CredentialCache;
}

function defaultCredentials(): Record<string, string> {
  return {
    "credential/vellum/platform_base_url": "https://vellum.ai",
    "credential/vellum/platform_assistant_id": "asst-123",
    "credential/vellum/assistant_api_key": "test-api-key",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const savedVellumPlatformUrl = process.env.VELLUM_PLATFORM_URL;
const savedPlatformAssistantId = process.env.PLATFORM_ASSISTANT_ID;
const savedPlatformInternalApiKey = process.env.PLATFORM_INTERNAL_API_KEY;

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  // Clear env vars that the production code falls back to, so tests remain
  // deterministic unless they explicitly set them.
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.PLATFORM_ASSISTANT_ID;
  delete process.env.PLATFORM_INTERNAL_API_KEY;
  mkdirSync(protectedDir, { recursive: true });
  clearRemoteFeatureFlagStoreCache();
  fetchMock = mock(async () => new Response());
});

afterEach(() => {
  if (savedBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = savedBaseDataDir;
  }
  // Restore env vars
  const restoreEnv = (key: string, saved: string | undefined): void => {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  };
  restoreEnv("VELLUM_PLATFORM_URL", savedVellumPlatformUrl);
  restoreEnv("PLATFORM_ASSISTANT_ID", savedPlatformAssistantId);
  restoreEnv("PLATFORM_INTERNAL_API_KEY", savedPlatformInternalApiKey);
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
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

  test("skips sync when assistant_api_key is missing and no PLATFORM_INTERNAL_API_KEY", async () => {
    const creds = defaultCredentials();
    delete creds["credential/vellum/assistant_api_key"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not use PLATFORM_INTERNAL_API_KEY when assistant_api_key is missing", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));
    process.env.PLATFORM_INTERNAL_API_KEY = "internal-key-123";

    const creds = defaultCredentials();
    delete creds["credential/vellum/assistant_api_key"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    // PLATFORM_INTERNAL_API_KEY is only for internal gateway endpoints —
    // feature flag sync requires assistant_api_key (Api-Key auth).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips sync when platform_assistant_id is missing and no PLATFORM_ASSISTANT_ID", async () => {
    const creds = defaultCredentials();
    delete creds["credential/vellum/platform_assistant_id"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls back to PLATFORM_ASSISTANT_ID env var when credential cache is empty", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));
    process.env.PLATFORM_ASSISTANT_ID = "env-asst-456";

    const creds = defaultCredentials();
    delete creds["credential/vellum/platform_assistant_id"];

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
    });
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/feature-flags/assistant-flag-values/");
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

  test("constructs correct URL with assistant ID", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const creds = {
      ...defaultCredentials(),
      "credential/vellum/platform_base_url": "https://platform.example.com",
      "credential/vellum/platform_assistant_id": "asst-abc-999",
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
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          // GA flag (defaultEnabled: true) — remote false should be dropped
          "conversation-starters": false,
          // Gated flag (defaultEnabled: false) — remote false is kept
          "email-channel": false,
          // GA flag set to true — should be kept (redundant but harmless)
          browser: true,
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
    // conversation-starters (GA, remote false) should be absent
    expect(cached["conversation-starters"]).toBeUndefined();
    // email-channel (gated, remote false) should be present
    expect(cached["email-channel"]).toBe(false);
    // browser (GA, remote true) should be present
    expect(cached.browser).toBe(true);
    // unknown-flag (not in registry, remote false) should be present
    expect(cached["unknown-flag"]).toBe(false);
  });

  test("trims whitespace from credential values", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const creds = {
      "credential/vellum/platform_base_url": "  https://platform.example.com  ",
      "credential/vellum/platform_assistant_id": "  asst-trimmed  ",
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
    // Simulate: first two fetches fail (missing creds), third succeeds.
    let callCount = 0;
    const credsFn = async (key: string) => {
      callCount++;
      // First 6 calls = 2 attempts × 3 credential reads each → missing API key.
      // After that, credentials are available.
      if (callCount <= 6) {
        if (key === "credential/vellum/assistant_api_key") return undefined;
        return defaultCredentials()[key];
      }
      return defaultCredentials()[key];
    };
    const creds = { get: credsFn } as unknown as CredentialCache;

    fetchMock = mock(async () =>
      Response.json({ flags: { "backoff-flag": true } }),
    );

    const sync = new RemoteFeatureFlagSync({
      credentials: creds,
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // Initial fetch failed (missing creds) — no fetch calls yet
    expect(fetchMock).not.toHaveBeenCalled();

    // Wait for first poll (50ms) — still fails (creds still missing)
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchMock).not.toHaveBeenCalled();

    // Wait for second poll (100ms = 50ms doubled) — creds now available
    await new Promise((r) => setTimeout(r, 130));
    expect(fetchMock).toHaveBeenCalledTimes(1);

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

  test("doubles poll interval on consecutive failures", async () => {
    // Always fail — missing creds
    const creds = defaultCredentials();
    delete creds["credential/vellum/assistant_api_key"];

    fetchMock = mock(async () => Response.json({ flags: {} }));

    const sync = new RemoteFeatureFlagSync({
      credentials: fakeCredentialCache(creds),
      initialPollIntervalMs: 50,
    });
    await sync.start();

    // No fetch calls (missing creds)
    expect(fetchMock).not.toHaveBeenCalled();

    // After 50ms: first poll fires, still fails → interval doubles to 100ms
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchMock).not.toHaveBeenCalled();

    // After another 100ms: second poll fires, still fails → interval doubles to 200ms
    await new Promise((r) => setTimeout(r, 130));
    expect(fetchMock).not.toHaveBeenCalled();

    // After another 200ms: third poll fires
    await new Promise((r) => setTimeout(r, 230));
    expect(fetchMock).not.toHaveBeenCalled();

    sync.stop();
  });
});
