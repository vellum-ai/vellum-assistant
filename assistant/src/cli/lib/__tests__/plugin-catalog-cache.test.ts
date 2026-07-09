/**
 * Tests for {@link getPluginCatalog}.
 *
 * Exercises the gate between the platform fetcher and the bundled reader plus
 * the per-ref TTL cache. Platform paths drive a fake `deps.fetch` returning a
 * `/v1/plugins/` payload (no real network); the offline path reads the bundled
 * manifest and must touch the network zero times.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { readBundledPluginCatalog } from "../plugin-catalog-local.js";
import type { SearchPluginsDeps } from "../search-plugins.js";
import {
  PLUGIN_CATALOG_CACHE_TTL_MS,
  getPluginCatalog,
  invalidatePluginCatalogCache,
} from "../plugin-catalog-cache.js";

// A non-zero base time. Bun treats `setSystemTime(new Date(0))` as "reset to
// the real clock", so the fake clock must start from a positive epoch.
const BASE_TIME_MS = 1_700_000_000_000;

/** A `deps.fetch` that serves a `/v1/plugins/` payload and counts its calls. */
function platformFetch(names: string[]): {
  fetch: FetchLike;
  calls: () => number;
} {
  let calls = 0;
  const body = JSON.stringify({
    plugins: names.map((name) => ({
      name,
      repo: `acme/${name}`,
      ref: "0".repeat(40),
    })),
  });
  const fetch: FetchLike = (async () => {
    calls += 1;
    return new Response(body, { status: 200 });
  }) as never;
  return { fetch, calls: () => calls };
}

/** A `deps.fetch` that always fails with a non-2xx (→ unavailable). */
function failingFetch(): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  const fetch: FetchLike = (async () => {
    calls += 1;
    return new Response("", { status: 503 });
  }) as never;
  return { fetch, calls: () => calls };
}

const ORIGINAL_ENV = {
  IS_PLATFORM: process.env.IS_PLATFORM,
  VELLUM_DISABLE_PLATFORM: process.env.VELLUM_DISABLE_PLATFORM,
};

describe("getPluginCatalog", () => {
  beforeEach(() => {
    invalidatePluginCatalogCache();
    // Default: platform features enabled (neither flag set).
    delete process.env.IS_PLATFORM;
    delete process.env.VELLUM_DISABLE_PLATFORM;
  });

  afterEach(() => {
    setSystemTime();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("fetches from the platform once, then serves cache within the TTL", async () => {
    // GIVEN platform features enabled and a platform fetcher returning ["a"]
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };

    // WHEN we request the same ref twice in quick succession
    const first = await getPluginCatalog("main", deps);
    const second = await getPluginCatalog("main", deps);

    // THEN the platform is fetched exactly once — the second call is cached
    expect(calls()).toBe(1);
    expect(first).toBe(second);
    expect(first.matches.map((m) => m.name)).toEqual(["a"]);
    expect(first.ref).toBe("main");
  });

  test("refetches after invalidation", async () => {
    // GIVEN a first successful load
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };
    await getPluginCatalog("main", deps);

    // WHEN the cache is invalidated and we request again
    invalidatePluginCatalogCache();
    await getPluginCatalog("main", deps);

    // THEN the platform is fetched a second time
    expect(calls()).toBe(2);
  });

  test("refetches after the TTL elapses", async () => {
    // GIVEN a fresh load at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };
    await getPluginCatalog("main", deps);

    // WHEN the TTL has elapsed and we request again
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    await getPluginCatalog("main", deps);

    // THEN the platform is fetched again
    expect(calls()).toBe(2);
  });

  test("fails hard on refresh failure — does NOT serve the stale cache", async () => {
    // GIVEN a good catalog cached at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const good = platformFetch(["good"]);
    const cached = await getPluginCatalog("main", { fetch: good.fetch });
    expect(cached.matches.map((m) => m.name)).toEqual(["good"]);

    // WHEN the TTL has elapsed and the refresh fails
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const failing = failingFetch();
    const err = await getPluginCatalog("main", { fetch: failing.fetch }).catch(
      (e: unknown) => e,
    );

    // THEN the failure propagates instead of serving the stale catalog
    expect(err).toBeInstanceOf(Error);
    expect(failing.calls()).toBe(1);
  });

  test("reads the bundled catalog with zero network when platform is disabled", async () => {
    // GIVEN platform features disabled (offline / self-hosted)
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    delete process.env.IS_PLATFORM;

    const { fetch, calls } = platformFetch(["ignored"]);
    const deps: SearchPluginsDeps = { fetch };

    // WHEN we request the catalog
    const result = await getPluginCatalog("main", deps);

    // THEN it comes from the bundled manifest and no fetch is made
    expect(calls()).toBe(0);
    const bundled = readBundledPluginCatalog();
    expect(result.matches).toEqual(bundled.matches);
    // The requested ref is echoed onto the wire contract.
    expect(result.ref).toBe("main");
  });
});
