/**
 * Tests for the offline (bundled) plugin catalog reader.
 *
 * The catalog is projected from the manifest bundled into the package at build
 * time — no network, no filesystem path resolution.
 */

import { describe, expect, test } from "bun:test";

import bundledManifest from "../bundled-marketplace.json" with { type: "json" };
import {
  buildBundledPluginCatalog,
  readBundledPluginCatalog,
} from "../plugin-catalog-local.js";

describe("buildBundledPluginCatalog", () => {
  test("yields one match per unique manifest name, sorted alphabetically", () => {
    const catalog = buildBundledPluginCatalog();

    expect(catalog.ref).toBe("bundled");
    // The catalog dedupes by name (first occurrence wins — see
    // `projectMarketplaceEntries`), so the match count tracks the number of
    // distinct names, not the raw entry count. The platform-generated manifest
    // can carry multiple entries under one name (e.g. a repin that appends a
    // new ref, or an icon-curation pass), and the reader collapses them.
    const uniqueNames = new Set(bundledManifest.plugins.map((p) => p.name));
    expect(catalog.matches.length).toBe(uniqueNames.size);

    const names = catalog.matches.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names).size).toBe(names.length);
  });

  test("projects each entry to the expected match shape", () => {
    const catalog = buildBundledPluginCatalog();
    const match = catalog.matches.find((m) => m.name === "caveman");

    expect(match).toEqual({
      name: "caveman",
      path: "github:JuliusBrussee/caveman@63a91ecadbf4c4719a4602a5abb00883f9966034",
      description:
        "Ultra-compressed communication mode that strips filler words to cut token usage.",
      category: "productivity",
      homepage: "https://github.com/JuliusBrussee/caveman",
      license: "MIT",
      icon: "🦴",
      source: {
        kind: "github",
        repo: "JuliusBrussee/caveman",
        path: undefined,
        ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
      },
    });
  });

  test("throws on a malformed manifest", () => {
    expect(() => buildBundledPluginCatalog({ plugins: [{}] })).toThrow();
  });
});

describe("readBundledPluginCatalog", () => {
  test("returns a stable memoized reference across calls", () => {
    expect(readBundledPluginCatalog()).toBe(readBundledPluginCatalog());
  });
});
