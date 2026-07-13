/**
 * Tests for the gated catalog resolvers.
 *
 * `resolveSourceFromMatch` is exercised as a pure function. The catalog-backed
 * resolvers run against the bundled manifest with platform features disabled
 * (`VELLUM_DISABLE_PLATFORM`, zero network), plus a platform-enabled case that
 * asserts a rejecting catalog fetch propagates rather than resolving to `null`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { invalidatePluginCatalogCache } from "../plugin-catalog-cache.js";
import {
  findCatalogEntry,
  resolvePluginSourceFromCatalog,
  resolveSourceFromMatch,
} from "../plugin-catalog-resolve.js";
import type { PluginSearchMatch, SearchPluginsDeps } from "../search-plugins.js";
import { PluginCatalogUnavailableError } from "../search-plugins.js";

const FULL_SHA = "63a91ecadbf4c4719a4602a5abb00883f9966034";

/** A synthetic catalog match with an overridable source. */
function match(
  source: Partial<PluginSearchMatch["source"]> = {},
): PluginSearchMatch {
  return {
    name: "example",
    path: "github:acme/example@ref",
    category: null,
    source: { kind: "github", repo: "acme/example", ref: FULL_SHA, ...source },
  };
}

describe("resolveSourceFromMatch", () => {
  test("returns owner/repo/path/ref for a full-SHA match", () => {
    expect(
      resolveSourceFromMatch(match({ repo: "acme/widget", path: "pkg/plugin" })),
    ).toEqual({
      owner: "acme",
      repo: "widget",
      path: "pkg/plugin",
      ref: FULL_SHA,
    });
  });

  test("defaults path to \"\" when the source declares none", () => {
    expect(resolveSourceFromMatch(match())).toEqual({
      owner: "acme",
      repo: "example",
      path: "",
      ref: FULL_SHA,
    });
  });

  test.each([
    ["a branch", "main"],
    ["a tag", "v1.2.3"],
    ["a short SHA", "63a91ec"],
  ])("throws on %s ref", (_label, ref) => {
    expect(() => resolveSourceFromMatch(match({ ref }))).toThrow();
  });
});

describe("catalog-backed resolvers (bundled, offline)", () => {
  const ORIGINAL_ENV = {
    IS_PLATFORM: process.env.IS_PLATFORM,
    VELLUM_DISABLE_PLATFORM: process.env.VELLUM_DISABLE_PLATFORM,
  };

  beforeEach(() => {
    invalidatePluginCatalogCache();
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    delete process.env.IS_PLATFORM;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {delete process.env[key];}
      else {process.env[key] = value;}
    }
  });

  // A rejecting fetch proves the bundled path never touches the network.
  const rejectingDeps: SearchPluginsDeps = {
    fetch: (async () => {
      throw new Error("network must not be used");
    }) as FetchLike,
  };

  test("findCatalogEntry returns the bundled entry for a known name", async () => {
    const entry = await findCatalogEntry("caveman", rejectingDeps);
    expect(entry?.name).toBe("caveman");
    expect(entry?.source).toEqual({
      kind: "github",
      repo: "JuliusBrussee/caveman",
      path: undefined,
      ref: FULL_SHA,
    });
  });

  test("resolvePluginSourceFromCatalog resolves a known name to its pinned source", async () => {
    expect(
      await resolvePluginSourceFromCatalog("caveman", rejectingDeps),
    ).toEqual({
      owner: "JuliusBrussee",
      repo: "caveman",
      path: "",
      ref: FULL_SHA,
    });
  });

  test("resolvePluginSourceFromCatalog returns null for an unknown name", async () => {
    expect(
      await resolvePluginSourceFromCatalog("no-such-plugin", rejectingDeps),
    ).toBeNull();
  });
});

describe("catalog-backed resolvers (platform enabled)", () => {
  const ORIGINAL_ENV = {
    IS_PLATFORM: process.env.IS_PLATFORM,
    VELLUM_DISABLE_PLATFORM: process.env.VELLUM_DISABLE_PLATFORM,
  };

  beforeEach(() => {
    invalidatePluginCatalogCache();
    delete process.env.IS_PLATFORM;
    delete process.env.VELLUM_DISABLE_PLATFORM;
  });

  afterEach(() => {
    invalidatePluginCatalogCache();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {delete process.env[key];}
      else {process.env[key] = value;}
    }
  });

  test("propagates PluginCatalogUnavailableError instead of resolving to null", async () => {
    const deps: SearchPluginsDeps = {
      fetch: (async () => {
        throw new Error("network down");
      }) as FetchLike,
    };
    const promise = resolvePluginSourceFromCatalog("caveman", deps);
    await expect(promise).rejects.toBeInstanceOf(PluginCatalogUnavailableError);
  });
});
