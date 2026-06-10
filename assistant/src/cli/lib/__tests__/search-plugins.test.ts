/**
 * Tests for {@link searchPlugins}.
 *
 * The catalog is the whitelisted external plugins in the curated
 * `plugins/marketplace.json` manifest. Network is replaced with an in-memory
 * fixture passed via the `fetch` dependency — no globals are monkey-patched and
 * no `--test-hook` exports leak into production code.
 */

import { describe, expect, test } from "bun:test";

import { MarketplaceFetchError } from "../plugin-marketplace.js";
import {
  type FetchLike,
  InvalidSearchPatternError,
  PluginCatalogUnavailableError,
  searchPlugins,
} from "../search-plugins.js";

const MANIFEST_URL_PREFIX =
  "https://api.github.com/repos/vellum-ai/vellum-assistant/contents/plugins/marketplace.json";

// External marketplace refs must be full commit SHAs (immutable). Fixtures use
// realistic 40-char hex object names rather than tags/branches.
const SHA_A = "63a91ecadbf4c4719a4602a5abb00883f9966034";
const SHA_B = "0123456789abcdef0123456789abcdef01234567";
const SHA_C = "89abcdef0123456789abcdef0123456789abcdef";

interface ManifestPlugin {
  name: string;
  source: { source: "github"; repo: string; path?: string; ref: string };
  description?: string;
}

/** Serve `plugins` as the raw marketplace manifest at the manifest URL. */
function manifestFetch(plugins: ManifestPlugin[]): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(MANIFEST_URL_PREFIX)) {
      return new Response("unexpected url: " + url, { status: 500 });
    }
    return new Response(JSON.stringify({ name: "vellum-assistant", plugins }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
}

/** A github-sourced manifest entry, with optional path/description. */
function entry(
  name: string,
  repo: string,
  ref: string,
  extra?: { path?: string; description?: string },
): ManifestPlugin {
  return {
    name,
    source: {
      source: "github",
      repo,
      ...(extra?.path ? { path: extra.path } : {}),
      ref,
    },
    ...(extra?.description ? { description: extra.description } : {}),
  };
}

describe("searchPlugins", () => {
  test("matches the query as a case-insensitive regex against plugin names", async () => {
    const result = await searchPlugins(
      { query: "memory" },
      {
        fetch: manifestFetch([
          entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
          entry("memory-graph", "acme/memory-graph", SHA_B),
          entry("git-tools", "acme/git-tools", SHA_C),
        ]),
      },
    );

    expect(result.matches.map((m) => m.name)).toEqual([
      "memory-graph",
      "simple-memory",
    ]);
    expect(result.matches[0]!.path).toBe(`github:acme/memory-graph@${SHA_B}`);
    expect(result.query).toBe("memory");
    expect(result.ref).toBe("main");
  });

  test("matches regardless of query casing (case-insensitive)", async () => {
    const result = await searchPlugins(
      { query: "MEMORY" },
      {
        fetch: manifestFetch([
          entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
        ]),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("anchored patterns work without escaping", async () => {
    const result = await searchPlugins(
      { query: "^memory-" },
      {
        fetch: manifestFetch([
          entry("memory-graph", "acme/memory-graph", SHA_B),
          entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
        ]),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual(["memory-graph"]);
  });

  test("empty query matches every whitelisted entry", async () => {
    const result = await searchPlugins(
      { query: "" },
      {
        fetch: manifestFetch([
          entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
          entry("memory-graph", "acme/memory-graph", SHA_B),
          entry("git-tools", "acme/git-tools", SHA_C),
        ]),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual([
      "git-tools",
      "memory-graph",
      "simple-memory",
    ]);
  });

  test("projects each entry onto a github source with a display locator", async () => {
    // GIVEN a whitelisted external plugin nested in a subdirectory
    // WHEN we search
    const result = await searchPlugins(
      { query: "nested" },
      {
        fetch: manifestFetch([
          entry("nested", "acme/monorepo", SHA_B, {
            path: "packages/nested",
            description: "A nested plugin.",
          }),
        ]),
      },
    );

    // THEN the match carries the github coordinates and a human locator
    expect(result.matches).toEqual([
      {
        name: "nested",
        path: `github:acme/monorepo/packages/nested@${SHA_B}`,
        description: "A nested plugin.",
        source: {
          kind: "github",
          repo: "acme/monorepo",
          path: "packages/nested",
          ref: SHA_B,
        },
      },
    ]);
  });

  test("rejects invalid regex patterns up front (no network call)", async () => {
    let fetchCalled = false;
    const fetch: FetchLike = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as FetchLike;

    await expect(
      searchPlugins({ query: "(unterminated" }, { fetch }),
    ).rejects.toBeInstanceOf(InvalidSearchPatternError);
    expect(fetchCalled).toBe(false);
  });

  test("empty result set on no matches", async () => {
    const result = await searchPlugins(
      { query: "nothing-matches" },
      {
        fetch: manifestFetch([
          entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
        ]),
      },
    );
    expect(result.matches).toEqual([]);
  });

  test("respects `ref` option by forwarding to GitHub", async () => {
    // The CLI does not surface a `--ref` flag (the source-path convention
    // may change), but the underlying function keeps `ref` for test
    // injection and future internal callers.
    let seenRef: string | undefined;
    const result = await searchPlugins(
      { query: "memory", ref: "feat-branch" },
      {
        fetch: (async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const m = /[?&]ref=([^&]+)/.exec(url);
          seenRef = m ? decodeURIComponent(m[1]!) : undefined;
          return new Response(
            JSON.stringify({
              name: "vellum-assistant",
              plugins: [
                entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as FetchLike,
      },
    );

    expect(seenRef).toBe("feat-branch");
    expect(result.ref).toBe("feat-branch");
    expect(result.matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("HTTP 5xx is a transient PluginCatalogUnavailableError", async () => {
    // GIVEN GitHub returns a 5xx (upstream outage)
    // WHEN we search
    // THEN the failure is classified transient so the caller can serve a
    // stale cache and the route can map it to 503 (not a misleading 500).
    const err = await searchPlugins(
      { query: "memory" },
      {
        fetch: (async () =>
          new Response("upstream broken", { status: 503 })) as FetchLike,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginCatalogUnavailableError);
    expect((err as PluginCatalogUnavailableError).status).toBe(503);
  });

  test("rate-limited 403 (x-ratelimit-remaining: 0) is transient", async () => {
    // GIVEN GitHub returns 403 with the rate-limit budget exhausted
    // WHEN we search
    // THEN it's transient — this is exactly the unauthenticated 60 req/hr
    // exhaustion that empties the catalog, and it must surface as 503.
    const err = await searchPlugins(
      { query: "memory" },
      {
        fetch: (async () =>
          new Response("rate limit exceeded", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          })) as FetchLike,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginCatalogUnavailableError);
    expect((err as PluginCatalogUnavailableError).status).toBe(403);
  });

  test("a 403 without the rate-limit signal is a hard error", async () => {
    // GIVEN a bare 403 (genuine permissions problem, not rate limiting)
    // WHEN we search
    // THEN it is NOT transient — serving a stale catalog would mask a real
    // misconfiguration, so it propagates as a plain error.
    const err = await searchPlugins(
      { query: "memory" },
      {
        fetch: (async () =>
          new Response("forbidden", { status: 403 })) as FetchLike,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PluginCatalogUnavailableError);
    expect((err as Error).message).toMatch(/HTTP 403/);
  });

  test("a missing manifest (404) is a clean empty catalog", async () => {
    // Unlike a 5xx or a bare 403, a 404 on `marketplace.json` means no
    // whitelist has been published at this ref yet — a normal empty catalog,
    // not a misconfiguration. The search returns no matches without error.
    const result = await searchPlugins(
      { query: "memory" },
      {
        fetch: (async () =>
          new Response("not found", { status: 404 })) as FetchLike,
      },
    );
    expect(result.matches).toEqual([]);
  });

  test("a malformed manifest is a hard error (not silently empty)", async () => {
    // GIVEN the manifest body is not valid JSON
    // WHEN we search
    // THEN it surfaces as a hard MarketplaceFetchError — the catalog is the
    // source of truth, so a broken whitelist must not masquerade as empty,
    // and it is NOT transient (retrying won't fix malformed bytes).
    const err = await searchPlugins(
      { query: "" },
      {
        fetch: (async () =>
          new Response("{ not json", { status: 200 })) as FetchLike,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceFetchError);
    expect(err).not.toBeInstanceOf(PluginCatalogUnavailableError);
  });

  test("returns matches sorted by name", async () => {
    const result = await searchPlugins(
      { query: "" },
      {
        fetch: manifestFetch([
          entry("zeta-plugin", "acme/zeta", SHA_A),
          entry("alpha-plugin", "acme/alpha", SHA_B),
          entry("mu-plugin", "acme/mu", SHA_C),
        ]),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual([
      "alpha-plugin",
      "mu-plugin",
      "zeta-plugin",
    ]);
  });

  test("dedupes entries that repeat a name, keeping the first", async () => {
    // GIVEN a manifest that lists the same name twice (e.g. a bad edit)
    // WHEN we search
    // THEN the name surfaces once, from the first entry, so a duplicate can't
    // inflate the catalog or shadow the reviewed source
    const result = await searchPlugins(
      { query: "caveman" },
      {
        fetch: manifestFetch([
          entry("caveman", "JuliusBrussee/caveman", SHA_A),
          entry("caveman", "impostor/caveman", SHA_B),
        ]),
      },
    );
    expect(result.matches).toEqual([
      {
        name: "caveman",
        path: `github:JuliusBrussee/caveman@${SHA_A}`,
        source: {
          kind: "github",
          repo: "JuliusBrussee/caveman",
          ref: SHA_A,
        },
      },
    ]);
  });

  test("sends no Authorization header (canonical source is a public repo)", async () => {
    let seenAuth: string | undefined;
    let seenUserAgent: string | undefined;
    await searchPlugins(
      { query: "memory" },
      {
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string> | undefined;
          seenAuth = headers?.Authorization;
          seenUserAgent = headers?.["User-Agent"];
          return new Response(
            JSON.stringify({ name: "vellum-assistant", plugins: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as FetchLike,
      },
    );
    expect(seenAuth).toBeUndefined();
    expect(seenUserAgent).toBe("vellum-assistant-cli");
  });
});
