import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import type { RemoteFeatureFlagSyncConfig } from "../remote-feature-flag-sync.js";

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
function makeConfig(
  overrides: Partial<RemoteFeatureFlagSyncConfig> = {},
): RemoteFeatureFlagSyncConfig {
  return {
    platformUrl: "https://assistant.vellum.ai",
    assistantId: "asst-123",
    platformApiKey: "test-api-key",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
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
  test("skips sync when platformUrl is empty", async () => {
    const sync = new RemoteFeatureFlagSync(makeConfig({ platformUrl: "" }));
    await sync.start();
    sync.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips sync when platformApiKey is empty", async () => {
    const sync = new RemoteFeatureFlagSync(makeConfig({ platformApiKey: "" }));
    await sync.start();
    sync.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fetches and caches flags on successful response", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: { "feature_flags.browser.enabled": true },
      }),
    );

    const sync = new RemoteFeatureFlagSync(makeConfig());
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({ "feature_flags.browser.enabled": true });
  });

  test("returns empty on non-OK response", async () => {
    fetchMock = mock(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const sync = new RemoteFeatureFlagSync(makeConfig());
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({});
  });

  test("returns empty on network error", async () => {
    fetchMock = mock(async () => {
      throw new Error("Network failure");
    });

    const sync = new RemoteFeatureFlagSync(makeConfig());
    // Should not throw — errors are caught and logged
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("sends correct auth header", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const apiKey = "my-secret-key-42";
    const sync = new RemoteFeatureFlagSync(
      makeConfig({ platformApiKey: apiKey }),
    );
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Api-Key ${apiKey}`);
  });

  test("constructs correct URL with assistant ID", async () => {
    fetchMock = mock(async () => Response.json({ flags: {} }));

    const cfg = makeConfig({
      platformUrl: "https://platform.example.com",
      assistantId: "asst-abc-999",
    });
    const sync = new RemoteFeatureFlagSync(cfg);
    await sync.start();
    sync.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://platform.example.com/v1/assistants/asst-abc-999/feature-flags/",
    );
  });

  test("filters non-boolean values from response", async () => {
    fetchMock = mock(async () =>
      Response.json({
        flags: {
          "feature_flags.browser.enabled": true,
          "feature_flags.contacts.enabled": "yes" as unknown,
          "feature_flags.other.enabled": 1 as unknown,
          "feature_flags.valid.enabled": false,
        },
      }),
    );

    const sync = new RemoteFeatureFlagSync(makeConfig());
    await sync.start();
    sync.stop();

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({
      "feature_flags.browser.enabled": true,
      "feature_flags.valid.enabled": false,
    });
  });

  test("returns empty when response is missing flags field", async () => {
    fetchMock = mock(async () => Response.json({ data: "unexpected" }));

    const sync = new RemoteFeatureFlagSync(makeConfig());
    await sync.start();
    sync.stop();

    clearRemoteFeatureFlagStoreCache();
    const cached = readRemoteFeatureFlags();
    expect(cached).toEqual({});
  });
});
