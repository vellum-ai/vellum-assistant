/**
 * Tests for {@link getPluginCatalog}.
 *
 * The underlying `loadPluginCatalog` is mocked so we exercise the cache's
 * TTL window, refresh-on-expiry, and stale-on-error fallback in isolation —
 * no network and no dependence on the real GitHub-backed loader.
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

import type { PluginCatalog, SearchPluginsDeps } from "../search-plugins.js";
import { PluginCatalogUnavailableError } from "../search-plugins.js";

// Mock the loader the cache wraps. `loadSpy` records every call and returns
// (or throws) whatever the test configures. The real error class is passed
// through so propagation preserves its identity.
const loadSpy = mock(
  async (
    _opts: { ref: string },
    _deps: SearchPluginsDeps,
  ): Promise<PluginCatalog> => {
    throw new Error("loadSpy default impl not configured");
  },
);

mock.module("../search-plugins.js", () => ({
  PluginCatalogUnavailableError,
  loadPluginCatalog: loadSpy,
}));

const {
  PLUGIN_CATALOG_CACHE_TTL_MS,
  getPluginCatalog,
  invalidatePluginCatalogCache,
} = await import("../plugin-catalog-cache.js");

const deps: SearchPluginsDeps = {
  fetch: (async () => new Response("", { status: 200 })) as never,
};

// A non-zero base time. Bun treats `setSystemTime(new Date(0))` as "reset to
// the real clock", so the fake clock must start from a positive epoch.
const BASE_TIME_MS = 1_700_000_000_000;

function catalog(ref: string, names: string[]): PluginCatalog {
  return {
    ref,
    matches: names.map((name) => ({
      name,
      path: `github:acme/${name}@${"0".repeat(40)}`,
      category: null,
      source: {
        kind: "github" as const,
        repo: `acme/${name}`,
        ref: "0".repeat(40),
      },
    })),
  };
}

describe("getPluginCatalog", () => {
  beforeEach(() => {
    loadSpy.mockClear();
    invalidatePluginCatalogCache();
  });

  afterEach(() => {
    // Restore real time in case a test installed a fake clock.
    setSystemTime();
  });

  test("loads once and serves the cached catalog within the TTL window", async () => {
    // GIVEN a loader that returns a catalog
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, ["a"]));

    // WHEN we request the same ref twice in quick succession
    const first = await getPluginCatalog("main", deps);
    const second = await getPluginCatalog("main", deps);

    // THEN the loader is consulted exactly once — the second call is cached
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.matches.map((m) => m.name)).toEqual(["a"]);
  });

  test("caches per ref independently", async () => {
    // GIVEN a loader that echoes the requested ref
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, [ref]));

    // WHEN we request two different refs
    const main = await getPluginCatalog("main", deps);
    const branch = await getPluginCatalog("feature", deps);

    // THEN each ref triggers its own load and is keyed separately
    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(main.ref).toBe("main");
    expect(branch.ref).toBe("feature");
  });

  test("refreshes after the TTL elapses", async () => {
    // GIVEN a fresh load at t0
    setSystemTime(new Date(BASE_TIME_MS));
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, ["v1"]));
    await getPluginCatalog("main", deps);

    // AND the loader now returns updated data
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, ["v2"]));

    // WHEN the TTL has elapsed and we request again
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const refreshed = await getPluginCatalog("main", deps);

    // THEN the loader is consulted again and the new catalog is returned
    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.matches.map((m) => m.name)).toEqual(["v2"]);
  });

  test("serves the stale catalog when a refresh fails", async () => {
    // GIVEN a good catalog cached at t0
    setSystemTime(new Date(BASE_TIME_MS));
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, ["good"]));
    const fresh = await getPluginCatalog("main", deps);

    // AND the upstream later fails (rate-limited)
    loadSpy.mockImplementation(async () => {
      throw new PluginCatalogUnavailableError("rate limited", 403);
    });

    // WHEN the TTL has elapsed and the refresh fails
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const stale = await getPluginCatalog("main", deps);

    // THEN the last good catalog is served instead of throwing
    expect(stale).toBe(fresh);
    expect(stale.matches.map((m) => m.name)).toEqual(["good"]);
  });

  test("resets the TTL window after serving stale so it doesn't re-fetch every call", async () => {
    // GIVEN a cached catalog and a now-failing upstream
    setSystemTime(new Date(BASE_TIME_MS));
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, ["good"]));
    await getPluginCatalog("main", deps);
    loadSpy.mockImplementation(async () => {
      throw new PluginCatalogUnavailableError("rate limited", 403);
    });

    // WHEN the TTL elapses (one failed refresh) and we immediately ask again
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    await getPluginCatalog("main", deps);
    const callsAfterFirstStale = loadSpy.mock.calls.length;
    await getPluginCatalog("main", deps);

    // THEN the second request is served from the reset window without
    // re-entering the failing loader
    expect(loadSpy.mock.calls.length).toBe(callsAfterFirstStale);
  });

  test("propagates a hard error even with a cache, and does not serve stale", async () => {
    // GIVEN a good catalog cached at t0
    setSystemTime(new Date(BASE_TIME_MS));
    loadSpy.mockImplementation(async ({ ref }) => catalog(ref, ["good"]));
    await getPluginCatalog("main", deps);

    // AND the upstream later fails with a HARD error (e.g. the prefix is
    // gone), NOT a transient PluginCatalogUnavailableError
    loadSpy.mockImplementation(async () => {
      throw new Error("GitHub contents listing failed: HTTP 404");
    });

    // WHEN the TTL has elapsed and the refresh hard-fails
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const err = await getPluginCatalog("main", deps).catch((e: unknown) => e);

    // THEN the hard error propagates instead of masking the misconfiguration
    // with stale data
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PluginCatalogUnavailableError);
    expect((err as Error).message).toMatch(/HTTP 404/);
  });

  test("propagates the error when there is no cache to fall back on", async () => {
    // GIVEN no prior successful load and a failing upstream
    loadSpy.mockImplementation(async () => {
      throw new PluginCatalogUnavailableError("rate limited", 403);
    });

    // WHEN we request a cold catalog
    const err = await getPluginCatalog("main", deps).catch((e: unknown) => e);

    // THEN the failure propagates so the caller can map it to 503
    expect(err).toBeInstanceOf(PluginCatalogUnavailableError);
  });
});
