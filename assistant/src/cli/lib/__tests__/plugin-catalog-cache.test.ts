/**
 * Tests for {@link getPluginCatalog}.
 *
 * Exercises the gate between the platform fetcher and the bundled reader, the
 * per-ref TTL cache, and the two read shapes over it: `fresh` reads await the
 * refresh and fail hard, display reads answer from cache and revalidate in the
 * background. Platform paths drive a fake `deps.fetch` returning a
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
import {
  getPluginCatalog,
  invalidatePluginCatalogCache,
  mergePlatformCatalogWithBundledLocals,
  PLUGIN_CATALOG_CACHE_TTL_MS,
  PLUGIN_CATALOG_FAILURE_RETRY_MS,
} from "../plugin-catalog-cache.js";
import { readBundledPluginCatalog } from "../plugin-catalog-local.js";
import type { SearchPluginsDeps } from "../search-plugins.js";
import type { PluginCatalog } from "../search-plugins.js";

// A non-zero base time. Bun treats `setSystemTime(new Date(0))` as "reset to
// the real clock", so the fake clock must start from a positive epoch.
const BASE_TIME_MS = 1_700_000_000_000;

function githubNames(catalog: PluginCatalog): string[] {
  return catalog.matches
    .filter((match) => match.source.kind === "github")
    .map((match) => match.name);
}

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

/**
 * A `deps.fetch` that serves a `/v1/plugins/` payload only once `release()` is
 * called, so a test can observe what a display read answers with while the
 * refresh is still in flight.
 */
function deferredPlatformFetch(names: string[]): {
  fetch: FetchLike;
  calls: () => number;
  release: () => void;
} {
  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = JSON.stringify({
    plugins: names.map((name) => ({
      name,
      repo: `acme/${name}`,
      ref: "0".repeat(40),
    })),
  });
  const fetch: FetchLike = (async () => {
    calls += 1;
    await gate;
    return new Response(body, { status: 200 });
  }) as never;
  return { fetch, calls: () => calls, release: () => release() };
}

/**
 * Drain the microtask queue so a background refresh settles into the cache.
 * The refresh chain is promise-only (no timers), so ticking microtasks is
 * enough and keeps the fake clock untouched.
 */
async function settleBackgroundRefresh(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
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
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("fetches from the platform once, then serves cache within the TTL", async () => {
    // GIVEN platform features enabled and a platform fetcher returning ["a"]
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };

    // WHEN we request the same ref twice in quick succession
    const first = await getPluginCatalog("main", deps, { fresh: true });
    const second = await getPluginCatalog("main", deps, { fresh: true });

    // THEN the platform is fetched exactly once — the second call is cached
    expect(calls()).toBe(1);
    expect(first).toBe(second);
    expect(githubNames(first)).toEqual(["a"]);
    expect(first.ref).toBe("main");
  });

  test("refetches after invalidation", async () => {
    // GIVEN a first successful load
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };
    await getPluginCatalog("main", deps, { fresh: true });

    // WHEN the cache is invalidated and we request again
    invalidatePluginCatalogCache();
    await getPluginCatalog("main", deps, { fresh: true });

    // THEN the platform is fetched a second time
    expect(calls()).toBe(2);
  });

  test("refetches after the TTL elapses", async () => {
    // GIVEN a fresh load at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };
    await getPluginCatalog("main", deps, { fresh: true });

    // WHEN the TTL has elapsed and we request again
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    await getPluginCatalog("main", deps, { fresh: true });

    // THEN the platform is fetched again
    expect(calls()).toBe(2);
  });

  test("a fresh read fails hard on refresh failure: does NOT serve the stale cache", async () => {
    // GIVEN a good catalog cached at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const good = platformFetch(["good"]);
    const cached = await getPluginCatalog(
      "main",
      { fetch: good.fetch },
      { fresh: true },
    );
    expect(githubNames(cached)).toEqual(["good"]);

    // WHEN the TTL has elapsed and the refresh fails
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const failing = failingFetch();
    const err = await getPluginCatalog(
      "main",
      { fetch: failing.fetch },
      { fresh: true },
    ).catch((e: unknown) => e);

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

  test("a display read on a cold cache serves the bundled manifest and starts one fetch", async () => {
    // GIVEN a platform fetch that has not answered yet
    const { fetch, calls, release } = deferredPlatformFetch(["a"]);

    // WHEN a display read lands
    const served = await getPluginCatalog("main", { fetch });

    // THEN the bundled manifest answers while the refresh is still in flight
    expect(served.matches).toEqual(readBundledPluginCatalog().matches);
    expect(served.ref).toBe("main");
    expect(calls()).toBe(1);

    release();
    await settleBackgroundRefresh();
  });

  test("display reads past the TTL serve the stale copy and share one refresh", async () => {
    // GIVEN a catalog cached at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const seed = platformFetch(["old"]);
    await getPluginCatalog("main", { fetch: seed.fetch }, { fresh: true });

    // WHEN five display reads land past the TTL
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const next = deferredPlatformFetch(["new"]);
    const served = await Promise.all(
      Array.from({ length: 5 }, () =>
        getPluginCatalog("main", { fetch: next.fetch }),
      ),
    );

    // THEN every one of them answers with the stale copy off a single refresh
    for (const catalog of served) {
      expect(githubNames(catalog)).toEqual(["old"]);
    }
    expect(next.calls()).toBe(1);

    next.release();
    await settleBackgroundRefresh();
  });

  test("the next read returns the new catalog once the background refresh lands", async () => {
    setSystemTime(new Date(BASE_TIME_MS));
    const seed = platformFetch(["old"]);
    await getPluginCatalog("main", { fetch: seed.fetch }, { fresh: true });

    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const next = platformFetch(["new"]);
    const stale = await getPluginCatalog("main", { fetch: next.fetch });
    expect(githubNames(stale)).toEqual(["old"]);

    await settleBackgroundRefresh();

    const fresh = await getPluginCatalog("main", { fetch: next.fetch });
    expect(githubNames(fresh)).toEqual(["new"]);
    expect(next.calls()).toBe(1);
  });

  test("onChanged fires once for a refresh that changes the catalog, never for an identical one", async () => {
    setSystemTime(new Date(BASE_TIME_MS));
    const seed = platformFetch(["a"]);
    await getPluginCatalog("main", { fetch: seed.fetch }, { fresh: true });

    let changed = 0;
    const onChanged = (): void => {
      changed += 1;
    };

    // WHEN the refresh brings a different catalog
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const grown = platformFetch(["a", "b"]);
    await getPluginCatalog("main", { fetch: grown.fetch }, { onChanged });
    await settleBackgroundRefresh();

    // THEN the caller that started it is told exactly once
    expect(changed).toBe(1);

    // WHEN the next refresh brings the same catalog back
    setSystemTime(new Date(BASE_TIME_MS + 2 * PLUGIN_CATALOG_CACHE_TTL_MS + 2));
    const same = platformFetch(["a", "b"]);
    await getPluginCatalog("main", { fetch: same.fetch }, { onChanged });
    await settleBackgroundRefresh();

    // THEN nothing is invalidated
    expect(changed).toBe(1);
  });

  test("a failed refresh keeps serving the last good copy and gates the display retry", async () => {
    setSystemTime(new Date(BASE_TIME_MS));
    const good = platformFetch(["good"]);
    await getPluginCatalog("main", { fetch: good.fetch }, { fresh: true });

    // WHEN the refresh past the TTL fails
    const staleAt = BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1;
    setSystemTime(new Date(staleAt));
    const failing = failingFetch();
    const first = await getPluginCatalog("main", { fetch: failing.fetch });
    expect(githubNames(first)).toEqual(["good"]);
    await settleBackgroundRefresh();

    // THEN a display read inside the retry gate serves the last good copy
    // without fetching again
    setSystemTime(new Date(staleAt + PLUGIN_CATALOG_FAILURE_RETRY_MS - 1));
    const gated = await getPluginCatalog("main", { fetch: failing.fetch });
    expect(githubNames(gated)).toEqual(["good"]);
    expect(failing.calls()).toBe(1);

    // ...while a fresh read ignores the gate and surfaces the failure
    const err = await getPluginCatalog(
      "main",
      { fetch: failing.fetch },
      { fresh: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(failing.calls()).toBe(2);
    await settleBackgroundRefresh();

    // THEN the display path fetches again once the gate has expired
    setSystemTime(new Date(staleAt + 2 * PLUGIN_CATALOG_FAILURE_RETRY_MS + 1));
    const recovered = platformFetch(["good", "better"]);
    await getPluginCatalog("main", { fetch: recovered.fetch });
    expect(recovered.calls()).toBe(1);
    await settleBackgroundRefresh();
  });

  test("a fresh read joins the in-flight display refresh instead of fetching twice", async () => {
    const deferred = deferredPlatformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch: deferred.fetch };

    // GIVEN a display read that started the refresh
    const served = await getPluginCatalog("main", deps);
    expect(served.matches).toEqual(readBundledPluginCatalog().matches);

    // WHEN a fresh read lands while it is still in flight
    const fresh = getPluginCatalog("main", deps, { fresh: true });
    deferred.release();

    // THEN it waits on the same fetch
    expect(githubNames(await fresh)).toEqual(["a"]);
    expect(deferred.calls()).toBe(1);
  });

  test("a display read that joins a fresh read's refresh still gets its one notification", async () => {
    const deferred = deferredPlatformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch: deferred.fetch };

    // GIVEN a fresh read that started the refresh with no callback
    const fresh = getPluginCatalog("main", deps, { fresh: true });

    // WHEN two display reads join it, each offering a callback
    let first = 0;
    let second = 0;
    await getPluginCatalog("main", deps, { onChanged: () => (first += 1) });
    await getPluginCatalog("main", deps, { onChanged: () => (second += 1) });
    deferred.release();
    await fresh;

    // THEN the one fetch fires the first callback offered, once
    expect(deferred.calls()).toBe(1);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  test("a display read within the TTL makes no fetch", async () => {
    setSystemTime(new Date(BASE_TIME_MS));
    const { fetch, calls } = platformFetch(["a"]);
    await getPluginCatalog("main", { fetch }, { fresh: true });

    setSystemTime(new Date(BASE_TIME_MS + 1));
    const served = await getPluginCatalog("main", { fetch });

    expect(githubNames(served)).toEqual(["a"]);
    expect(calls()).toBe(1);
  });
});

describe("mergePlatformCatalogWithBundledLocals", () => {
  test("adds local packages while keeping a platform row on name collision", () => {
    const platform: PluginCatalog = {
      ref: "main",
      matches: [
        {
          name: "fathom",
          path: "github:provider/fathom@pin",
          category: null,
          source: {
            kind: "github",
            repo: "provider/fathom",
            ref: "0".repeat(40),
          },
        },
      ],
    };
    const bundled: PluginCatalog = {
      ref: "bundled",
      matches: [
        {
          name: "fathom",
          path: "local:plugins/mcp-catalog/fathom@1.0.0",
          category: null,
          source: {
            kind: "local",
            path: "plugins/mcp-catalog/fathom",
            version: "1.0.0",
          },
        },
        {
          name: "notion",
          path: "local:plugins/mcp-catalog/notion@1.0.0",
          category: null,
          source: {
            kind: "local",
            path: "plugins/mcp-catalog/notion",
            version: "1.0.0",
          },
        },
      ],
    };

    const merged = mergePlatformCatalogWithBundledLocals(platform, bundled);

    expect(merged.matches.map((match) => match.name)).toEqual([
      "fathom",
      "notion",
    ]);
    expect(merged.matches[0]?.source.kind).toBe("github");
    expect(merged.matches[1]?.source.kind).toBe("local");
    expect(merged.ref).toBe("main");
  });
});
