/**
 * Tests for {@link fetchMarketplaceEntries} and {@link resolveMarketplaceSource}.
 *
 * Network is replaced with an in-memory fixture passed via the `fetch`
 * dependency — no globals are monkey-patched.
 */

import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import {
  fetchMarketplaceEntries,
  type MarketplaceEntry,
  MarketplaceFetchError,
  resolveMarketplaceSource,
} from "../plugin-marketplace.js";

const MANIFEST_URL_PREFIX =
  "https://api.github.com/repos/vellum-ai/vellum-assistant/contents/plugins/marketplace.json";

// External marketplace refs must be full commit SHAs (immutable). Fixtures use
// realistic 40-char hex object names rather than tags/branches.
const CAVEMAN_SHA = "63a91ecadbf4c4719a4602a5abb00883f9966034";
const NESTED_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Serve `body` (any value) as the raw manifest file at the manifest URL. */
function manifestFetch(body: unknown, status = 200, raw?: string): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(MANIFEST_URL_PREFIX)) {
      return new Response("unexpected url: " + url, { status: 500 });
    }
    if (status !== 200) {
      return new Response("error", { status });
    }
    return new Response(raw ?? JSON.stringify(body), { status: 200 });
  }) as FetchLike;
}

const VALID_MANIFEST = {
  name: "vellum-assistant",
  owner: { name: "Vellum" },
  plugins: [
    {
      name: "caveman",
      source: {
        source: "github",
        repo: "JuliusBrussee/caveman",
        ref: CAVEMAN_SHA,
      },
      description: "Ultra-compressed communication mode.",
      category: "productivity",
    },
    {
      name: "nested",
      source: {
        source: "github",
        repo: "acme/monorepo",
        path: "packages/nested",
        ref: NESTED_SHA,
      },
    },
  ],
};

describe("fetchMarketplaceEntries", () => {
  test("parses a valid manifest and returns its plugin entries", async () => {
    // GIVEN a canonical repo serving a valid marketplace manifest
    const fetch = manifestFetch(VALID_MANIFEST);

    // WHEN we fetch the marketplace entries at a ref
    const entries = await fetchMarketplaceEntries({ fetch }, { ref: "main" });

    // THEN both whitelisted plugins are returned with their pinned sources
    expect(entries.map((e) => e.name)).toEqual(["caveman", "nested"]);
    expect(entries[0]!.source).toEqual({
      source: "github",
      repo: "JuliusBrussee/caveman",
      ref: CAVEMAN_SHA,
    });
    expect(entries[1]!.source.path).toBe("packages/nested");
  });

  test("forwards the ref to the GitHub Contents API", async () => {
    // GIVEN a fixture that records the ref query parameter
    let seenRef: string | undefined;
    const fetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seenRef = /[?&]ref=([^&]+)/.exec(url)?.[1];
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
    }) as FetchLike;

    // WHEN we fetch at an explicit ref
    await fetchMarketplaceEntries({ fetch }, { ref: "feat-branch" });

    // THEN the ref reaches GitHub
    expect(seenRef).toBe("feat-branch");
  });

  test("treats a missing manifest (404) as an empty whitelist", async () => {
    // GIVEN no manifest exists at this ref
    const fetch = manifestFetch(null, 404);

    // WHEN we fetch the entries
    const entries = await fetchMarketplaceEntries({ fetch }, { ref: "main" });

    // THEN the absence is a normal empty result, not an error
    expect(entries).toEqual([]);
  });

  test("throws MarketplaceFetchError on non-404 HTTP failure", async () => {
    // GIVEN GitHub returns a server error
    const fetch = manifestFetch(null, 503);

    // WHEN / THEN the failure surfaces as a typed error
    await expect(
      fetchMarketplaceEntries({ fetch }, { ref: "main" }),
    ).rejects.toBeInstanceOf(MarketplaceFetchError);
  });

  test("throws MarketplaceFetchError on non-JSON body", async () => {
    // GIVEN the manifest body is not valid JSON
    const fetch = manifestFetch(undefined, 200, "{ not json");

    // WHEN / THEN parsing fails loudly
    await expect(
      fetchMarketplaceEntries({ fetch }, { ref: "main" }),
    ).rejects.toBeInstanceOf(MarketplaceFetchError);
  });

  test("rejects a mutable tag or branch ref (must be a full commit SHA)", async () => {
    // GIVEN an entry whose source pins a mutable tag rather than a commit SHA
    const fetch = manifestFetch({
      name: "x",
      plugins: [
        {
          name: "caveman",
          source: {
            source: "github",
            repo: "JuliusBrussee/caveman",
            ref: "v1.8.2",
          },
        },
      ],
    });

    // WHEN / THEN the mutable ref is rejected: a retag could repoint it at
    // attacker code the daemon later dynamically imports.
    await expect(
      fetchMarketplaceEntries({ fetch }, { ref: "main" }),
    ).rejects.toBeInstanceOf(MarketplaceFetchError);
  });

  test("rejects an abbreviated commit SHA", async () => {
    // GIVEN an entry whose source uses a short (ambiguous, non-pinning) SHA
    const fetch = manifestFetch({
      name: "x",
      plugins: [
        {
          name: "caveman",
          source: {
            source: "github",
            repo: "JuliusBrussee/caveman",
            ref: "63a91ec",
          },
        },
      ],
    });

    // WHEN / THEN only a full object name pins the install immutably
    await expect(
      fetchMarketplaceEntries({ fetch }, { ref: "main" }),
    ).rejects.toBeInstanceOf(MarketplaceFetchError);
  });

  test("rejects a manifest entry missing a pinned ref", async () => {
    // GIVEN an entry whose source omits the required ref
    const fetch = manifestFetch({
      name: "x",
      plugins: [
        { name: "floating", source: { source: "github", repo: "a/b" } },
      ],
    });

    // WHEN / THEN schema validation rejects the unpinned source
    await expect(
      fetchMarketplaceEntries({ fetch }, { ref: "main" }),
    ).rejects.toBeInstanceOf(MarketplaceFetchError);
  });

  test("rejects a path that escapes the repo root", async () => {
    // GIVEN an entry whose path contains a parent-segment escape
    const fetch = manifestFetch({
      name: "x",
      plugins: [
        {
          name: "escape",
          source: {
            source: "github",
            repo: "a/b",
            path: "../../etc",
            ref: "main",
          },
        },
      ],
    });

    // WHEN / THEN the unsafe path is rejected
    await expect(
      fetchMarketplaceEntries({ fetch }, { ref: "main" }),
    ).rejects.toBeInstanceOf(MarketplaceFetchError);
  });
});

describe("resolveMarketplaceSource", () => {
  const entries: readonly MarketplaceEntry[] = [
    {
      name: "caveman",
      source: {
        source: "github",
        repo: "JuliusBrussee/caveman",
        ref: CAVEMAN_SHA,
      },
    },
    {
      name: "nested",
      source: {
        source: "github",
        repo: "acme/monorepo",
        path: "packages/nested",
        ref: NESTED_SHA,
      },
    },
  ];

  test("resolves a repo-root plugin to owner/repo with empty path", () => {
    // GIVEN whitelisted entries
    // WHEN resolving a name whose source has no sub-path
    const resolved = resolveMarketplaceSource("caveman", entries);

    // THEN the owner/repo split out and path defaults to repo root
    expect(resolved).toEqual({
      owner: "JuliusBrussee",
      repo: "caveman",
      path: "",
      ref: CAVEMAN_SHA,
    });
  });

  test("resolves a sub-path plugin to its directory", () => {
    // GIVEN whitelisted entries
    // WHEN resolving a name whose source pins a sub-path
    const resolved = resolveMarketplaceSource("nested", entries);

    // THEN the sub-path is preserved
    expect(resolved).toEqual({
      owner: "acme",
      repo: "monorepo",
      path: "packages/nested",
      ref: NESTED_SHA,
    });
  });

  test("returns null for a name not in the whitelist", () => {
    // GIVEN whitelisted entries
    // WHEN resolving an unknown name
    // THEN no source is returned (the name is not installable)
    expect(resolveMarketplaceSource("unknown", entries)).toBeNull();
  });
});
