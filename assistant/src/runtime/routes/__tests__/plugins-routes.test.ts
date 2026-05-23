/**
 * Tests for the plugins route handlers in `plugins-routes.ts`.
 *
 * GET /v1/plugins (list):
 *   - Projection from `InstalledPluginInfo` → response shape (id, name,
 *     description, version, path; issues omitted when empty)
 *   - `?q=` substring filter (case-insensitive across id/name/description)
 *   - Trimming + empty-string fallthrough on `?q=`
 *   - Empty install dir → `{ plugins: [] }`
 *   - Issues array surfaced when present
 *
 * GET /v1/plugins/search (catalog search):
 *   - Forwards `?q=` and `?ref=` to the `searchPlugins` lib
 *   - Empty / missing `?q=` is passed through as the empty-regex
 *     ("match-all") query — the lib's documented contract
 *   - Wraps `InvalidSearchPatternError` into a 400 (BadRequestError)
 *   - Wraps unknown errors into a 500 (InternalError) with the lib's
 *     message preserved
 *   - Re-packs the lib's `readonly` match array into mutable arrays so
 *     downstream serializers can introspect freely
 *
 * The library functions themselves are covered by
 * `assistant/src/cli/lib/__tests__/list-installed-plugins.test.ts` and
 * `assistant/src/cli/lib/__tests__/search-plugins.test.ts`; here we
 * mock them to isolate the route's wiring logic.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { InstalledPluginInfo } from "../../../cli/lib/list-installed-plugins.js";
import type {
  PluginSearchMatch,
  SearchPluginsDeps,
  SearchPluginsOptions,
  SearchPluginsResult,
} from "../../../cli/lib/search-plugins.js";
import { InvalidSearchPatternError } from "../../../cli/lib/search-plugins.js";

// Mutable list returned by the mocked library function. Tests reassign
// `installedFixture` before invoking the handler.
let installedFixture: InstalledPluginInfo[] = [];

mock.module("../../../cli/lib/list-installed-plugins.js", () => ({
  listInstalledPlugins: () => installedFixture,
}));

// Mock searchPlugins: `searchSpy` records every invocation; the implementation
// returns whatever `searchResult` is set to (or throws `searchError` when set).
const searchSpy = mock(
  async (
    _opts: SearchPluginsOptions,
    _deps: SearchPluginsDeps,
  ): Promise<SearchPluginsResult> => {
    throw new Error("searchSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/search-plugins.js", () => ({
  // Pass through the real error classes — the route handler checks
  // `instanceof InvalidSearchPatternError`.
  InvalidSearchPatternError,
  searchPlugins: searchSpy,
}));

import { BadRequestError, InternalError } from "../errors.js";
import { ROUTES as PLUGINS_ROUTES } from "../plugins-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = PLUGINS_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const listHandler = findHandler("plugins_list");
const searchHandler = findHandler("plugins_search");

function invoke(
  args: RouteHandlerArgs = {},
): { plugins: Array<Record<string, unknown>> } {
  return listHandler(args) as { plugins: Array<Record<string, unknown>> };
}

async function invokeSearch(args: RouteHandlerArgs = {}): Promise<{
  query: string;
  ref: string;
  matches: PluginSearchMatch[];
}> {
  return (await searchHandler(args)) as {
    query: string;
    ref: string;
    matches: PluginSearchMatch[];
  };
}

function pluginEntry(
  overrides: Partial<InstalledPluginInfo> & { name: string },
): InstalledPluginInfo {
  return {
    name: overrides.name,
    target: overrides.target ?? `/tmp/plugins/${overrides.name}`,
    packageJson: overrides.packageJson ?? null,
    issues: overrides.issues ?? [],
  };
}

beforeEach(() => {
  installedFixture = [];
});

describe("GET /v1/plugins", () => {
  test("returns { plugins: [] } when nothing is installed", () => {
    expect(invoke()).toEqual({ plugins: [] });
  });

  test("projects InstalledPluginInfo → response shape with all fields populated", () => {
    installedFixture = [
      pluginEntry({
        name: "alpha",
        target: "/workspace/plugins/alpha",
        packageJson: {
          name: "alpha",
          version: "1.2.3",
          description: "Alpha plugin",
        },
      }),
    ];

    const result = invoke();
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toEqual({
      id: "alpha",
      name: "alpha",
      description: "Alpha plugin",
      version: "1.2.3",
      path: "/workspace/plugins/alpha",
    });
    // `issues` is omitted (not just undefined) when the entry is clean.
    expect("issues" in result.plugins[0]!).toBe(false);
  });

  test("uses directory name for `id` and `name` even when package.json#name is scoped", () => {
    installedFixture = [
      pluginEntry({
        name: "fancy-plugin",
        packageJson: {
          name: "@vendor/fancy-plugin",
          version: "0.0.1",
          description: undefined,
        },
      }),
    ];

    const [entry] = invoke().plugins;
    expect(entry?.id).toBe("fancy-plugin");
    expect(entry?.name).toBe("fancy-plugin");
  });

  test("nulls description and version when package.json is missing or partial", () => {
    installedFixture = [
      pluginEntry({ name: "no-pkg-json", packageJson: null }),
      pluginEntry({
        name: "partial",
        packageJson: { name: "partial" }, // no version / description
      }),
    ];

    const [missing, partial] = invoke().plugins;
    expect(missing).toMatchObject({
      id: "no-pkg-json",
      description: null,
      version: null,
    });
    expect(partial).toMatchObject({
      id: "partial",
      description: null,
      version: null,
    });
  });

  test("surfaces non-fatal issues array when present", () => {
    installedFixture = [
      pluginEntry({
        name: "broken",
        packageJson: null,
        issues: ["missing package.json"],
      }),
    ];

    const [entry] = invoke().plugins;
    expect(entry?.issues).toEqual(["missing package.json"]);
  });

  test("?q= filters case-insensitively on id, name, and description", () => {
    installedFixture = [
      pluginEntry({
        name: "calendar-sync",
        packageJson: {
          name: "calendar-sync",
          version: "1.0.0",
          description: "Sync events with Google Calendar",
        },
      }),
      pluginEntry({
        name: "weather",
        packageJson: {
          name: "weather",
          version: "1.0.0",
          description: "Show local conditions",
        },
      }),
      pluginEntry({
        name: "todo",
        packageJson: {
          name: "todo",
          version: "1.0.0",
          description: "Lightweight todo manager",
        },
      }),
    ];

    // id match
    expect(
      invoke({ queryParams: { q: "calendar" } }).plugins.map((p) => p.id),
    ).toEqual(["calendar-sync"]);

    // description match (case-insensitive)
    expect(
      invoke({ queryParams: { q: "GOOGLE" } }).plugins.map((p) => p.id),
    ).toEqual(["calendar-sync"]);

    // matches multiple
    expect(
      invoke({ queryParams: { q: "o" } }).plugins.map((p) => p.id).sort(),
    ).toEqual(["calendar-sync", "todo", "weather"].sort());

    // no match
    expect(invoke({ queryParams: { q: "zzz" } }).plugins).toEqual([]);
  });

  test("?q= is trimmed; whitespace-only treated as no filter", () => {
    installedFixture = [
      pluginEntry({ name: "alpha" }),
      pluginEntry({ name: "beta" }),
    ];

    expect(
      invoke({ queryParams: { q: "   " } }).plugins.map((p) => p.id),
    ).toEqual(["alpha", "beta"]);
  });

  test("preserves the order returned by listInstalledPlugins", () => {
    installedFixture = [
      pluginEntry({ name: "alpha" }),
      pluginEntry({ name: "beta" }),
      pluginEntry({ name: "zeta" }),
    ];

    expect(invoke().plugins.map((p) => p.id)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/plugins/search
// ---------------------------------------------------------------------------

describe("GET /v1/plugins/search", () => {
  beforeEach(() => {
    searchSpy.mockClear();
    // Default to a happy-path resolution; individual tests override as needed.
    searchSpy.mockImplementation(async (opts) => ({
      query: opts.query,
      ref: opts.ref ?? "main",
      matches: [],
    }));
  });

  test("forwards ?q= and ?ref= to searchPlugins; returns its result", async () => {
    searchSpy.mockImplementation(async (opts) => ({
      query: opts.query,
      ref: opts.ref ?? "main",
      matches: [
        { name: "simple-memory", path: "experimental/plugins/simple-memory" },
        { name: "simple-router", path: "experimental/plugins/simple-router" },
      ],
    }));

    const result = await invokeSearch({
      queryParams: { q: "^simple", ref: "my-feature-branch" },
    });

    // The lib received the exact query + ref we surfaced from the route.
    expect(searchSpy).toHaveBeenCalledTimes(1);
    const [opts] = searchSpy.mock.calls[0]!;
    expect(opts.query).toBe("^simple");
    expect(opts.ref).toBe("my-feature-branch");

    expect(result).toEqual({
      query: "^simple",
      ref: "my-feature-branch",
      matches: [
        { name: "simple-memory", path: "experimental/plugins/simple-memory" },
        { name: "simple-router", path: "experimental/plugins/simple-router" },
      ],
    });
  });

  test("missing ?q= passes empty string through (match-all per lib contract)", async () => {
    await invokeSearch();
    const [opts] = searchSpy.mock.calls[0]!;
    expect(opts.query).toBe("");
    // ref is omitted (undefined) when caller doesn't supply one — lib
    // applies its DEFAULT_PLUGIN_REF fallback.
    expect(opts.ref).toBeUndefined();
  });

  test("whitespace-only ?ref= is treated as missing", async () => {
    await invokeSearch({ queryParams: { q: "x", ref: "   " } });
    const [opts] = searchSpy.mock.calls[0]!;
    expect(opts.ref).toBeUndefined();
  });

  test("supplies a bound globalThis.fetch as the lib's fetch dep", async () => {
    await invokeSearch({ queryParams: { q: "memory" } });
    const [, deps] = searchSpy.mock.calls[0]!;
    expect(typeof deps.fetch).toBe("function");
  });

  test("InvalidSearchPatternError → BadRequestError (400)", async () => {
    searchSpy.mockImplementation(async () => {
      throw new InvalidSearchPatternError("(", new SyntaxError("unbalanced"));
    });

    await expect(
      invokeSearch({ queryParams: { q: "(" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    searchSpy.mockImplementation(async () => {
      throw new Error("GitHub contents listing failed: HTTP 502");
    });

    await expect(
      invokeSearch({ queryParams: { q: "memory" } }),
    ).rejects.toMatchObject({
      // The route wraps in InternalError so callers see a 500 response
      // with the upstream message attached.
      constructor: InternalError,
      message: expect.stringContaining("GitHub contents listing failed"),
    });
  });

  test("re-packs readonly match array into a mutable copy", async () => {
    const frozenMatches = Object.freeze([
      Object.freeze({ name: "a", path: "experimental/plugins/a" }),
    ]) as readonly PluginSearchMatch[];
    searchSpy.mockImplementation(async (opts) => ({
      query: opts.query,
      ref: opts.ref ?? "main",
      matches: frozenMatches,
    }));

    const result = await invokeSearch({ queryParams: { q: "a" } });
    // The route returns a non-frozen array we can mutate without
    // touching the lib's internal cache. This matters when serializers
    // (or downstream test fixtures) reach in.
    expect(Object.isFrozen(result.matches)).toBe(false);
    expect(() => result.matches.push({ name: "b", path: "x" })).not.toThrow();
  });
});
