/**
 * Tests for the catalog query helpers: {@link filterPluginCatalog},
 * {@link assertValidSearchPattern}, and {@link marketplaceMatch}.
 *
 * These operate purely in memory on a resolved catalog — the catalog itself
 * is resolved elsewhere (`getPluginCatalog`), so there is no network here.
 */

import { describe, expect, test } from "bun:test";

import { buildBundledPluginCatalog } from "../plugin-catalog-local.js";
import type { MarketplaceEntry } from "../plugin-marketplace.js";
import {
  assertValidSearchPattern,
  filterPluginCatalog,
  InvalidSearchPatternError,
  marketplaceMatch,
  type PluginCatalog,
  projectMarketplaceEntries,
} from "../search-plugins.js";

// External marketplace refs must be full commit SHAs (immutable). Fixtures use
// realistic 40-char hex object names rather than tags/branches.
const SHA_A = "63a91ecadbf4c4719a4602a5abb00883f9966034";
const SHA_B = "0123456789abcdef0123456789abcdef01234567";
const SHA_C = "89abcdef0123456789abcdef0123456789abcdef";

/** A github-sourced marketplace entry, with optional path/description. */
function entry(
  name: string,
  repo: string,
  ref: string,
  extra?: {
    path?: string;
    description?: string;
    category?: string;
    homepage?: string;
    license?: string;
  },
): MarketplaceEntry {
  return {
    name,
    source: {
      source: "github",
      repo,
      ...(extra?.path ? { path: extra.path } : {}),
      ref,
    },
    ...(extra?.description ? { description: extra.description } : {}),
    ...(extra?.category ? { category: extra.category } : {}),
    ...(extra?.homepage ? { homepage: extra.homepage } : {}),
    ...(extra?.license ? { license: extra.license } : {}),
  };
}

/** Build a resolved {@link PluginCatalog} from raw entries the way the catalog
 * sources do (dedupe by name, project, sort), reusing the real projection. */
function catalog(entries: MarketplaceEntry[], ref = "main"): PluginCatalog {
  return {
    ...buildBundledPluginCatalog({ name: "vellum-assistant", plugins: entries }),
    ref,
  };
}

describe("filterPluginCatalog", () => {
  test("matches the query as a case-insensitive regex against plugin names", () => {
    const matches = filterPluginCatalog(
      catalog([
        entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
        entry("memory-graph", "acme/memory-graph", SHA_B),
        entry("git-tools", "acme/git-tools", SHA_C),
      ]),
      "memory",
    );
    expect(matches.map((m) => m.name)).toEqual([
      "memory-graph",
      "simple-memory",
    ]);
    expect(matches[0]!.path).toBe(`github:acme/memory-graph@${SHA_B}`);
  });

  test("matches regardless of query casing (case-insensitive)", () => {
    const matches = filterPluginCatalog(
      catalog([entry("simple-memory", "vellum-ai/simple-memory", SHA_A)]),
      "MEMORY",
    );
    expect(matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("anchored patterns work without escaping", () => {
    const matches = filterPluginCatalog(
      catalog([
        entry("memory-graph", "acme/memory-graph", SHA_B),
        entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
      ]),
      "^memory-",
    );
    expect(matches.map((m) => m.name)).toEqual(["memory-graph"]);
  });

  test("empty query matches every catalog entry", () => {
    const matches = filterPluginCatalog(
      catalog([
        entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
        entry("memory-graph", "acme/memory-graph", SHA_B),
        entry("git-tools", "acme/git-tools", SHA_C),
      ]),
      "",
    );
    expect(matches.map((m) => m.name)).toEqual([
      "git-tools",
      "memory-graph",
      "simple-memory",
    ]);
  });

  test("empty result set on no matches", () => {
    const matches = filterPluginCatalog(
      catalog([entry("simple-memory", "vellum-ai/simple-memory", SHA_A)]),
      "nothing-matches",
    );
    expect(matches).toEqual([]);
  });

  test("throws InvalidSearchPatternError on a malformed pattern", () => {
    expect(() =>
      filterPluginCatalog(catalog([]), "(unterminated"),
    ).toThrow(InvalidSearchPatternError);
  });
});

describe("assertValidSearchPattern", () => {
  test("accepts a valid regex", () => {
    expect(() => assertValidSearchPattern("^memory-")).not.toThrow();
  });

  test("accepts an empty pattern (matches everything)", () => {
    expect(() => assertValidSearchPattern("")).not.toThrow();
  });

  test("throws InvalidSearchPatternError on a malformed pattern", () => {
    expect(() => assertValidSearchPattern("(unterminated")).toThrow(
      InvalidSearchPatternError,
    );
  });
});

describe("marketplaceMatch", () => {
  test("projects a root entry onto a github source with a display locator", () => {
    expect(
      marketplaceMatch(entry("simple-memory", "vellum-ai/simple-memory", SHA_A)),
    ).toEqual({
      name: "simple-memory",
      path: `github:vellum-ai/simple-memory@${SHA_A}`,
      description: undefined,
      category: null,
      homepage: undefined,
      license: undefined,
      source: {
        kind: "github",
        repo: "vellum-ai/simple-memory",
        path: undefined,
        ref: SHA_A,
      },
    });
  });

  test("projects a nested entry with its sub-path in the locator", () => {
    expect(
      marketplaceMatch(
        entry("nested", "acme/monorepo", SHA_B, {
          path: "packages/nested",
          description: "A nested plugin.",
        }),
      ),
    ).toEqual({
      name: "nested",
      path: `github:acme/monorepo/packages/nested@${SHA_B}`,
      description: "A nested plugin.",
      category: null,
      homepage: undefined,
      license: undefined,
      source: {
        kind: "github",
        repo: "acme/monorepo",
        path: "packages/nested",
        ref: SHA_B,
      },
    });
  });

  test("carries the marketplace category, defaulting to null when absent", () => {
    expect(
      marketplaceMatch(
        entry("calendar-sync", "acme/calendar-sync", SHA_A, {
          category: "calendar",
        }),
      ).category,
    ).toBe("calendar");
    expect(
      marketplaceMatch(entry("plain-plugin", "acme/plain-plugin", SHA_B))
        .category,
    ).toBeNull();
  });

  test("carries homepage/license when the entry declares them", () => {
    const match = marketplaceMatch(
      entry("calendar-sync", "acme/calendar-sync", SHA_A, {
        homepage: "https://example.com/calendar-sync",
        license: "MIT",
      }),
    );
    expect(match.homepage).toBe("https://example.com/calendar-sync");
    expect(match.license).toBe("MIT");
  });

  test("leaves homepage/license undefined when the entry omits them", () => {
    const match = marketplaceMatch(
      entry("plain-plugin", "acme/plain-plugin", SHA_B),
    );
    expect(match.homepage).toBeUndefined();
    expect(match.license).toBeUndefined();
  });
});

describe("projectMarketplaceEntries", () => {
  test("dedupes by name (first wins) and sorts alphabetically", () => {
    const matches = projectMarketplaceEntries([
      entry("git-tools", "acme/git-tools", SHA_C),
      entry("memory-graph", "acme/memory-graph", SHA_B),
      entry("git-tools", "acme/other-git-tools", SHA_A),
    ]);
    expect(matches.map((m) => m.name)).toEqual(["git-tools", "memory-graph"]);
    // First occurrence wins on a name collision.
    expect(matches[0]!.source.repo).toBe("acme/git-tools");
  });

  test("projects each entry via marketplaceMatch", () => {
    const [match] = projectMarketplaceEntries([
      entry("simple-memory", "vellum-ai/simple-memory", SHA_A),
    ]);
    expect(match).toEqual(
      marketplaceMatch(entry("simple-memory", "vellum-ai/simple-memory", SHA_A)),
    );
  });

  test("returns an empty list for no entries", () => {
    expect(projectMarketplaceEntries([])).toEqual([]);
  });

  test("carries homepage/license through, undefined when the entry omits them", () => {
    const [withMeta, without] = projectMarketplaceEntries([
      entry("calendar-sync", "acme/calendar-sync", SHA_A, {
        homepage: "https://example.com/calendar-sync",
        license: "MIT",
      }),
      entry("plain-plugin", "acme/plain-plugin", SHA_B),
    ]);
    expect(withMeta).toMatchObject({
      homepage: "https://example.com/calendar-sync",
      license: "MIT",
    });
    expect(without!.homepage).toBeUndefined();
    expect(without!.license).toBeUndefined();
  });
});
