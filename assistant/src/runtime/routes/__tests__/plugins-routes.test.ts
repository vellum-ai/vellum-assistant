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
 * DELETE /v1/plugins/:name (uninstall):
 *   - Forwards `pathParams.name` to the `uninstallPlugin` lib
 *   - Returns `{ name, target }` mirroring the lib's `UninstallPluginResult`
 *   - Maps `InvalidPluginNameError` → BadRequestError (400)
 *   - Maps `PluginNotInstalledError` → NotFoundError (404)
 *   - Maps unknown errors → InternalError (500) with message preserved
 *
 * The library functions themselves are covered by
 * `assistant/src/cli/lib/__tests__/list-installed-plugins.test.ts`,
 * `.../search-plugins.test.ts`, and `.../uninstall-plugin.test.ts`;
 * here we mock them to isolate the route's wiring logic.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type InspectPluginDeps,
  type InspectPluginOptions,
  type PluginInspection,
  PluginInspectNotFoundError,
} from "../../../cli/lib/inspect-plugin.js";
import {
  type InstallPluginOptions,
  type InstallPluginResult,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginSourceUnavailableError,
} from "../../../cli/lib/install-from-github.js";
import type { InstalledPluginInfo } from "../../../cli/lib/list-installed-plugins.js";
import {
  type PluginDetails,
  PluginDetailsNotFoundError,
  type PluginDetailsOptions,
} from "../../../cli/lib/plugin-details.js";
import type {
  PluginCatalog,
  PluginSearchMatch,
  SearchPluginsDeps,
} from "../../../cli/lib/search-plugins.js";
import { PluginCatalogUnavailableError } from "../../../cli/lib/search-plugins.js";
import {
  PluginNotInstalledError,
  type UninstallPluginOptions,
  type UninstallPluginResult,
} from "../../../cli/lib/uninstall-plugin.js";
import {
  PluginNotUpgradableError,
  type PluginUpgradeResult,
  type UpgradePluginDeps,
  type UpgradePluginOptions,
} from "../../../cli/lib/upgrade-plugin.js";

// Mutable list returned by the mocked library function. Tests reassign
// `installedFixture` before invoking the handler.
let installedFixture: InstalledPluginInfo[] = [];

mock.module("../../../cli/lib/list-installed-plugins.js", () => ({
  listInstalledPlugins: () => installedFixture,
}));

// Mock the catalog cache: `getCatalogSpy` records every invocation and
// returns the (unfiltered) catalog the route then filters in memory via the
// real `filterPluginCatalog`. The real `search-plugins.js` module is left
// unmocked so filtering + error classes behave exactly as in production.
const getCatalogSpy = mock(
  async (_ref: string, _deps: SearchPluginsDeps): Promise<PluginCatalog> => {
    throw new Error("getCatalogSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/plugin-catalog-cache.js", () => ({
  getPluginCatalog: getCatalogSpy,
}));

// Mock uninstallPlugin. The handler's error mapping is the wiring under
// test — the lib's own behavior is covered separately.
const uninstallSpy = mock(
  (_opts: UninstallPluginOptions): UninstallPluginResult => {
    throw new Error("uninstallSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/uninstall-plugin.js", () => ({
  // Pass through error classes — the handler checks `instanceof`.
  PluginNotInstalledError,
  uninstallPlugin: uninstallSpy,
}));

// Mock installPlugin. As with the other libs, the handler's error mapping
// is the wiring under test; the lib's own behavior is covered separately.
const installSpy = mock(
  async (_opts: InstallPluginOptions): Promise<InstallPluginResult> => {
    throw new Error("installSpy default impl not configured");
  },
);

// `InvalidPluginNameError` is re-exported from uninstall-plugin.js but
// the canonical definition lives in install-from-github.js. The
// handler imports from install-from-github.js, so mock that too so the
// `instanceof` checks inside the handler resolve to the same classes as
// the ones the spies throw. The error classes are passed through real so
// `instanceof` aligns.
mock.module("../../../cli/lib/install-from-github.js", () => ({
  DEFAULT_PLUGIN_REF: "main",
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  installPlugin: installSpy,
}));

// Mock getPluginDetails: the detail handler unions disk + manifest + repo
// in the lib (covered by plugin-details.test.ts); here we isolate the
// route's error mapping and pass-through.
const detailsSpy = mock(
  async (_opts: PluginDetailsOptions): Promise<PluginDetails> => {
    throw new Error("detailsSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/plugin-details.js", () => ({
  PluginDetailsNotFoundError,
  getPluginDetails: detailsSpy,
}));

// Mock inspectPlugin: the lib computes the local-vs-remote drift (covered by
// inspect-plugin.test.ts); the route only forwards the name and maps errors.
const inspectSpy = mock(
  async (
    _opts: InspectPluginOptions,
    _deps: InspectPluginDeps,
  ): Promise<PluginInspection> => {
    throw new Error("inspectSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/inspect-plugin.js", () => ({
  PluginInspectNotFoundError,
  inspectPlugin: inspectSpy,
}));

// Mock upgradePlugin: the lib performs the re-pin (covered by
// upgrade-plugin.test.ts); the route projects its result and maps errors.
const upgradeSpy = mock(
  async (
    _opts: UpgradePluginOptions,
    _deps: UpgradePluginDeps,
  ): Promise<PluginUpgradeResult> => {
    throw new Error("upgradeSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/upgrade-plugin.js", () => ({
  PluginNotUpgradableError,
  upgradePlugin: upgradeSpy,
}));

import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import { ROUTES as PLUGINS_ROUTES } from "../plugins-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = PLUGINS_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const listHandler = findHandler("plugins_list");
const searchHandler = findHandler("plugins_search");
const uninstallHandler = findHandler("plugins_uninstall");
const getHandler = findHandler("plugins_get");
const installHandler = findHandler("plugins_install");
const inspectHandler = findHandler("plugins_inspect");
const upgradeHandler = findHandler("plugins_upgrade");

function invoke(args: RouteHandlerArgs = {}): {
  plugins: Array<Record<string, unknown>>;
} {
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
      invoke({ queryParams: { q: "o" } })
        .plugins.map((p) => p.id)
        .sort(),
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

function catalog(
  ref: string,
  matches: readonly PluginSearchMatch[],
): PluginCatalog {
  return { ref, matches };
}

describe("GET /v1/plugins/search", () => {
  beforeEach(() => {
    getCatalogSpy.mockClear();
    // Default to a happy-path empty catalog; individual tests override.
    getCatalogSpy.mockImplementation(async (ref) => catalog(ref, []));
  });

  test("resolves the catalog at the requested ref and filters by ?q=", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "simple-memory",
          path: "github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
          source: {
            kind: "github",
            repo: "vellum-ai/simple-memory",
            ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
          },
        },
        {
          name: "caveman",
          path: "github:JuliusBrussee/caveman@v1.8.2",
          description: "Ultra-compressed communication mode.",
          source: {
            kind: "github",
            repo: "JuliusBrussee/caveman",
            ref: "v1.8.2",
          },
        },
      ]),
    );

    const result = await invokeSearch({
      queryParams: { q: "^simple", ref: "my-feature-branch" },
    });

    // The cache was consulted once at the requested ref.
    expect(getCatalogSpy).toHaveBeenCalledTimes(1);
    const [ref] = getCatalogSpy.mock.calls[0]!;
    expect(ref).toBe("my-feature-branch");

    // The query is applied in-memory by the real filter: `^simple` matches
    // only `simple-memory`, and the source discriminator is preserved.
    expect(result).toEqual({
      query: "^simple",
      ref: "my-feature-branch",
      matches: [
        {
          name: "simple-memory",
          path: "github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
          source: {
            kind: "github",
            repo: "vellum-ai/simple-memory",
            ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
          },
        },
      ],
    });
  });

  test("missing ?q= matches all (empty-string query) at the default ref", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "caveman",
          path: "github:JuliusBrussee/caveman@v1.8.2",
          source: {
            kind: "github",
            repo: "JuliusBrussee/caveman",
            ref: "v1.8.2",
          },
        },
      ]),
    );
    const result = await invokeSearch();
    const [ref] = getCatalogSpy.mock.calls[0]!;
    // No ref supplied → route resolves the default ref before caching.
    expect(ref).toBe("main");
    expect(result.query).toBe("");
    expect(result.matches.map((m) => m.name)).toEqual(["caveman"]);
  });

  test("whitespace-only ?ref= falls back to the default ref", async () => {
    await invokeSearch({ queryParams: { q: "x", ref: "   " } });
    const [ref] = getCatalogSpy.mock.calls[0]!;
    expect(ref).toBe("main");
  });

  test("supplies a bound globalThis.fetch as the catalog loader's fetch dep", async () => {
    await invokeSearch({ queryParams: { q: "memory" } });
    const [, deps] = getCatalogSpy.mock.calls[0]!;
    expect(typeof deps.fetch).toBe("function");
  });

  test("InvalidSearchPatternError → BadRequestError (400), before any catalog load", async () => {
    // GIVEN a malformed regex query and a cold cache
    // WHEN the search runs
    // THEN it's a deterministic 400 AND the catalog is never loaded, so a
    // user typo can't waste a GitHub request (which would otherwise surface
    // as 503 on a rate-limited cold cache).
    await expect(
      invokeSearch({ queryParams: { q: "(" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(getCatalogSpy).not.toHaveBeenCalled();
  });

  test("PluginCatalogUnavailableError → ServiceUnavailableError (503)", async () => {
    getCatalogSpy.mockImplementation(async () => {
      throw new PluginCatalogUnavailableError(
        "GitHub contents listing failed for plugins @ main: HTTP 403",
        403,
      );
    });

    // A rate-limited upstream (with no cache to fall back on) is transient
    // and retryable — the route surfaces it as 503, not a misleading 500.
    await expect(
      invokeSearch({ queryParams: { q: "memory" } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    getCatalogSpy.mockImplementation(async () => {
      throw new Error("GitHub contents listing failed: HTTP 404");
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
      Object.freeze({
        name: "a",
        path: "github:acme/a@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        source: {
          kind: "github",
          repo: "acme/a",
          ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        } as const,
      }),
    ]) as readonly PluginSearchMatch[];
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, frozenMatches),
    );

    const result = await invokeSearch({ queryParams: { q: "a" } });
    // The route returns a non-frozen array we can mutate without
    // touching the lib's internal cache. This matters when serializers
    // (or downstream test fixtures) reach in.
    expect(Object.isFrozen(result.matches)).toBe(false);
    expect(() =>
      result.matches.push({
        name: "b",
        path: "x",
        source: {
          kind: "github",
          repo: "acme/b",
          ref: "cccccccccccccccccccccccccccccccccccccccc",
        },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/plugins/:name (uninstall)
// ---------------------------------------------------------------------------

function invokeUninstall(args: RouteHandlerArgs = {}): {
  name: string;
  target: string;
} {
  return uninstallHandler(args) as { name: string; target: string };
}

describe("DELETE /v1/plugins/:name", () => {
  beforeEach(() => {
    uninstallSpy.mockReset();
  });

  test("forwards pathParams.name to uninstallPlugin and returns its result", () => {
    uninstallSpy.mockImplementation((opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
    }));

    const result = invokeUninstall({ pathParams: { name: "simple-memory" } });

    expect(uninstallSpy.mock.calls).toHaveLength(1);
    expect(uninstallSpy.mock.calls[0]?.[0]).toEqual({ name: "simple-memory" });
    expect(result).toEqual({
      name: "simple-memory",
      target: "/workspace/.vellum/plugins/simple-memory",
    });
  });

  test("missing pathParams.name passes the empty string through to the lib", () => {
    // The lib's `sanitizePluginName` is the validator of last resort —
    // the route hands off the raw value without pre-trimming. The lib
    // rejects empty strings, which the handler maps to 400 below.
    uninstallSpy.mockImplementation(() => {
      throw new InvalidPluginNameError(
        'Invalid plugin name "" — must match /^[a-z][a-z0-9-]{0,63}$/.',
      );
    });

    expect(() => invokeUninstall({})).toThrow(BadRequestError);
    expect(uninstallSpy.mock.calls[0]?.[0]).toEqual({ name: "" });
  });

  test("InvalidPluginNameError → BadRequestError (400)", () => {
    uninstallSpy.mockImplementation(() => {
      throw new InvalidPluginNameError("bad name ../escape");
    });

    expect(() =>
      invokeUninstall({ pathParams: { name: "../escape" } }),
    ).toThrow(BadRequestError);
  });

  test("PluginNotInstalledError → NotFoundError (404)", () => {
    uninstallSpy.mockImplementation((opts) => {
      throw new PluginNotInstalledError(
        opts.name,
        `/workspace/.vellum/plugins/${opts.name}`,
      );
    });

    expect(() => invokeUninstall({ pathParams: { name: "ghost" } })).toThrow(
      NotFoundError,
    );
  });

  test("unknown errors → InternalError with original message preserved", () => {
    uninstallSpy.mockImplementation(() => {
      throw new Error("EBUSY: resource busy or locked");
    });

    expect(() =>
      invokeUninstall({ pathParams: { name: "simple-memory" } }),
    ).toThrow(InternalError);
    try {
      invokeUninstall({ pathParams: { name: "simple-memory" } });
    } catch (err) {
      expect((err as Error).message).toContain("EBUSY");
    }
  });

  test("non-Error throws fall through to InternalError with a default message", () => {
    uninstallSpy.mockImplementation(() => {
      throw "boom"; // emulates a poorly-typed throwable from the lib chain
    });

    let caught: unknown;
    try {
      invokeUninstall({ pathParams: { name: "simple-memory" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as Error).message).toBe("plugin uninstall failed");
  });
});

function pluginDetails(overrides: Partial<PluginDetails> = {}): PluginDetails {
  return {
    name: overrides.name ?? "caveman",
    installed: overrides.installed ?? false,
    description: overrides.description ?? null,
    homepage: overrides.homepage ?? null,
    license: overrides.license ?? null,
    version: overrides.version ?? null,
    source: overrides.source ?? {
      kind: "github",
      repo: "JuliusBrussee/caveman",
      ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    },
    readme: overrides.readme ?? null,
    ref: overrides.ref ?? "main",
    artifact: overrides.artifact ?? null,
  };
}

async function invokeGet(args: RouteHandlerArgs = {}): Promise<PluginDetails> {
  return (await getHandler(args)) as PluginDetails;
}

describe("GET /v1/plugins/:name", () => {
  beforeEach(() => {
    detailsSpy.mockReset();
  });

  test("forwards name + ref to getPluginDetails and returns the detail view", async () => {
    const view = pluginDetails({
      name: "caveman",
      installed: true,
      description: "A loud agent plugin",
      homepage: "https://example.com/caveman",
      license: "MIT",
      version: "1.8.2",
      source: { kind: "github", repo: "example-org/caveman", ref: "v1.8.2" },
      readme: "# Caveman\n\nHello.",
      ref: "v1.8.2",
    });
    detailsSpy.mockImplementation(async () => view);

    const result = await invokeGet({
      pathParams: { name: "caveman" },
      queryParams: { ref: "v1.8.2" },
    });

    expect(result).toEqual(view);
    expect(detailsSpy.mock.calls[0]?.[0]).toEqual({
      name: "caveman",
      ref: "v1.8.2",
    });
  });

  test("omits ref (passes undefined) when the query param is absent or blank", async () => {
    detailsSpy.mockImplementation(async () => pluginDetails());

    await invokeGet({ pathParams: { name: "caveman" }, queryParams: {} });
    expect(detailsSpy.mock.calls[0]?.[0]).toEqual({
      name: "caveman",
      ref: undefined,
    });

    await invokeGet({
      pathParams: { name: "caveman" },
      queryParams: { ref: "   " },
    });
    expect(detailsSpy.mock.calls[1]?.[0]).toEqual({
      name: "caveman",
      ref: undefined,
    });
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    detailsSpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("../escape");
    });

    await expect(
      invokeGet({ pathParams: { name: "../escape" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("PluginDetailsNotFoundError → NotFoundError (404)", async () => {
    detailsSpy.mockImplementation(async () => {
      throw new PluginDetailsNotFoundError("ghost", "main");
    });

    await expect(
      invokeGet({ pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    detailsSpy.mockImplementation(async () => {
      throw new Error("ENOTFOUND api.github.com");
    });

    let caught: unknown;
    try {
      await invokeGet({ pathParams: { name: "caveman" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as Error).message).toContain("ENOTFOUND");
  });
});

async function invokeInstall(args: RouteHandlerArgs = {}): Promise<{
  ok: true;
  name: string;
  target: string;
  fileCount: number;
  ref: string;
}> {
  return (await installHandler(args)) as {
    ok: true;
    name: string;
    target: string;
    fileCount: number;
    ref: string;
  };
}

describe("POST /v1/plugins/install", () => {
  beforeEach(() => {
    installSpy.mockReset();
  });

  test("forwards name/force and shapes the result, pinning ref to the default", async () => {
    installSpy.mockImplementation(async (opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
      fileCount: 7,
      ref: opts.ref ?? "main",
      commit: null,
      committedAt: null,
    }));

    const result = await invokeInstall({
      body: { name: "caveman", force: true },
    });

    expect(result).toEqual({
      ok: true,
      name: "caveman",
      target: "/workspace/.vellum/plugins/caveman",
      fileCount: 7,
      ref: "main",
    });
    expect(installSpy.mock.calls[0]?.[0]).toEqual({
      name: "caveman",
      ref: "main",
      force: true,
    });
  });

  test("ignores a caller-supplied ref and pins to the curated default", async () => {
    // Security boundary: installing from an unreviewed ref (a PR branch,
    // fork ref, ...) could load attacker-controlled marketplace code, so the
    // HTTP route never honors a body `ref` — it always resolves
    // against the curated default ref.
    installSpy.mockImplementation(async (opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
      fileCount: 7,
      ref: opts.ref ?? "main",
      commit: null,
      committedAt: null,
    }));

    const result = await invokeInstall({
      body: { name: "caveman", ref: "attacker-pr-branch" },
    });

    expect(result.ref).toBe("main");
    expect(installSpy.mock.calls[0]?.[0]).toEqual({
      name: "caveman",
      ref: "main",
      force: undefined,
    });
  });

  test("a missing name short-circuits to BadRequestError without calling the lib", async () => {
    await expect(invokeInstall({ body: {} })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(installSpy).not.toHaveBeenCalled();
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    installSpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("../escape");
    });

    await expect(
      invokeInstall({ body: { name: "../escape" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("PluginAlreadyInstalledError → ConflictError (409)", async () => {
    installSpy.mockImplementation(async (opts) => {
      throw new PluginAlreadyInstalledError(
        opts.name,
        `/workspace/.vellum/plugins/${opts.name}`,
      );
    });

    await expect(
      invokeInstall({ body: { name: "caveman" } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("PluginNotFoundError → NotFoundError (404)", async () => {
    installSpy.mockImplementation(async (opts) => {
      throw new PluginNotFoundError(opts.name, "main", "example-org/ghost");
    });

    await expect(
      invokeInstall({ body: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PluginSourceUnavailableError → ServiceUnavailableError (503)", async () => {
    // A rate-limited or temporarily-down GitHub source is retryable: the
    // route surfaces 503 so the client can back off and try again, rather
    // than a misleading 500 that reads as a permanent failure.
    installSpy.mockImplementation(async () => {
      throw new PluginSourceUnavailableError(
        "GitHub tree listing for JuliusBrussee/caveman @ v1.8.2: HTTP 403",
        403,
      );
    });

    await expect(
      invokeInstall({ body: { name: "caveman" } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    installSpy.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });

    let caught: unknown;
    try {
      await invokeInstall({ body: { name: "caveman" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as Error).message).toContain("ECONNRESET");
  });
});

function inspection(
  overrides: Partial<PluginInspection> = {},
): PluginInspection {
  return {
    name: overrides.name ?? "level-up",
    installed: overrides.installed ?? true,
    status: overrides.status ?? "update-available",
    local:
      overrides.local === undefined
        ? {
            target: "/workspace/.vellum/plugins/level-up",
            commit: "60a392b0000000000000000000000000000000aa",
            committedAt: "2026-06-01T12:34:56.000Z",
            version: "0.1.0",
            description: "Surfaces a Level Up diff card.",
            installedAt: "2026-06-08T00:00:00.000Z",
            source: {
              kind: "github",
              owner: "vellum-ai",
              repo: "level-up",
              ref: "60a392b0000000000000000000000000000000aa",
            },
            localChanges: {
              modified: [],
              added: [],
              removed: [],
              clean: true,
            },
            issues: [],
          }
        : overrides.local,
    remote:
      overrides.remote === undefined
        ? {
            repo: "vellum-ai/level-up",
            path: "",
            commit: "3eae1820000000000000000000000000000000bb",
            committedAt: "2026-06-05T08:12:24.000Z",
            description: "Surfaces a Level Up diff card.",
            homepage: "https://github.com/vellum-ai/level-up",
            license: "MIT",
            category: null,
            marketplaceRef: "main",
          }
        : overrides.remote,
    remoteError: overrides.remoteError ?? null,
  };
}

async function invokeInspect(
  args: RouteHandlerArgs = {},
): Promise<PluginInspection> {
  return (await inspectHandler(args)) as PluginInspection;
}

describe("GET /v1/plugins/:name/inspect", () => {
  beforeEach(() => {
    inspectSpy.mockReset();
  });

  test("forwards the name to inspectPlugin and returns the drift verbatim", async () => {
    // GIVEN inspectPlugin reports an available update for an installed plugin
    const view = inspection({ status: "update-available" });
    inspectSpy.mockImplementation(async () => view);

    // WHEN the route handler is invoked with the path name
    const result = await invokeInspect({ pathParams: { name: "level-up" } });

    // THEN the inspection is returned unchanged
    expect(result).toEqual(view);
    // AND the name is forwarded to the lib (ref is never caller-supplied)
    expect(inspectSpy.mock.calls[0]?.[0]).toEqual({ name: "level-up" });
  });

  test("a captured marketplace error is returned as 200 with remote-unavailable, not thrown", async () => {
    // GIVEN the catalog was unreachable but a local copy exists, so the lib
    // returns a status rather than throwing
    const view = inspection({
      status: "remote-unavailable",
      remote: null,
      remoteError: "ENOTFOUND raw.githubusercontent.com",
    });
    inspectSpy.mockImplementation(async () => view);

    // WHEN the handler runs
    const result = await invokeInspect({ pathParams: { name: "level-up" } });

    // THEN it resolves (does not throw) and surfaces the captured error
    expect(result.status).toBe("remote-unavailable");
    expect(result.remoteError).toContain("ENOTFOUND");
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    inspectSpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("../escape");
    });

    await expect(
      invokeInspect({ pathParams: { name: "../escape" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("PluginInspectNotFoundError → NotFoundError (404)", async () => {
    inspectSpy.mockImplementation(async () => {
      throw new PluginInspectNotFoundError("ghost");
    });

    await expect(
      invokeInspect({ pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    inspectSpy.mockImplementation(async () => {
      throw new Error("EUNEXPECTED");
    });

    let caught: unknown;
    try {
      await invokeInspect({ pathParams: { name: "level-up" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as Error).message).toContain("EUNEXPECTED");
  });
});

function upgradeResult(
  overrides: Partial<PluginUpgradeResult> = {},
): PluginUpgradeResult {
  return {
    name: overrides.name ?? "level-up",
    outcome: overrides.outcome ?? "upgraded",
    fromCommit:
      overrides.fromCommit === undefined
        ? "60a392b0000000000000000000000000000000aa"
        : overrides.fromCommit,
    fromTimestamp:
      overrides.fromTimestamp === undefined
        ? "2026-06-01T12:34:56.000Z"
        : overrides.fromTimestamp,
    toCommit: overrides.toCommit ?? "3eae1820000000000000000000000000000000bb",
    toTimestamp:
      overrides.toTimestamp === undefined
        ? "2026-06-05T08:12:24.000Z"
        : overrides.toTimestamp,
    target: overrides.target ?? "/workspace/.vellum/plugins/level-up",
    fileCount: overrides.fileCount === undefined ? 12 : overrides.fileCount,
    dryRun: overrides.dryRun ?? false,
    provenanceWasUnknown: overrides.provenanceWasUnknown ?? false,
  };
}

async function invokeUpgrade(args: RouteHandlerArgs = {}): Promise<{
  name: string;
  outcome: string;
  fromCommit: string | null;
  fromTimestamp: string | null;
  toCommit: string;
  toTimestamp: string | null;
  target: string;
  fileCount: number | null;
  dryRun: boolean;
  provenanceWasUnknown: boolean;
}> {
  return (await upgradeHandler(args)) as {
    name: string;
    outcome: string;
    fromCommit: string | null;
    fromTimestamp: string | null;
    toCommit: string;
    toTimestamp: string | null;
    target: string;
    fileCount: number | null;
    dryRun: boolean;
    provenanceWasUnknown: boolean;
  };
}

describe("POST /v1/plugins/:name/upgrade", () => {
  beforeEach(() => {
    upgradeSpy.mockReset();
  });

  test("forwards name + dryRun and projects the upgrade result", async () => {
    // GIVEN upgradePlugin reports a successful re-pin
    upgradeSpy.mockImplementation(async () => upgradeResult());

    // WHEN the handler runs with an explicit dryRun flag
    const result = await invokeUpgrade({
      pathParams: { name: "level-up" },
      body: { dryRun: false },
    });

    // THEN the result is projected onto the wire shape
    expect(result).toEqual({
      name: "level-up",
      outcome: "upgraded",
      fromCommit: "60a392b0000000000000000000000000000000aa",
      fromTimestamp: "2026-06-01T12:34:56.000Z",
      toCommit: "3eae1820000000000000000000000000000000bb",
      toTimestamp: "2026-06-05T08:12:24.000Z",
      target: "/workspace/.vellum/plugins/level-up",
      fileCount: 12,
      dryRun: false,
      provenanceWasUnknown: false,
    });
    // AND the name + dryRun are forwarded to the lib
    expect(upgradeSpy.mock.calls[0]?.[0]).toEqual({
      name: "level-up",
      dryRun: false,
    });
  });

  test("omits dryRun (passes undefined) when the body flag is absent", async () => {
    // GIVEN a no-op upgrade where the install already matches the pin
    upgradeSpy.mockImplementation(async () =>
      upgradeResult({
        outcome: "already-up-to-date",
        toCommit: "60a392b0000000000000000000000000000000aa",
        fileCount: null,
      }),
    );

    // WHEN invoked without a body
    const result = await invokeUpgrade({ pathParams: { name: "level-up" } });

    // THEN the no-op outcome is surfaced
    expect(result.outcome).toBe("already-up-to-date");
    expect(result.fileCount).toBeNull();
    // AND dryRun is passed through as undefined (not coerced to false)
    expect(upgradeSpy.mock.calls[0]?.[0]).toEqual({
      name: "level-up",
      dryRun: undefined,
    });
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    upgradeSpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("../escape");
    });

    await expect(
      invokeUpgrade({ pathParams: { name: "../escape" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("PluginNotInstalledError → NotFoundError (404)", async () => {
    upgradeSpy.mockImplementation(async () => {
      throw new PluginNotInstalledError(
        "ghost",
        "/workspace/.vellum/plugins/ghost",
      );
    });

    await expect(
      invokeUpgrade({ pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PluginNotUpgradableError → ConflictError (409)", async () => {
    // The install exists but has no marketplace entry to advance to: a
    // well-formed request that isn't actionable in the current state.
    upgradeSpy.mockImplementation(async () => {
      throw new PluginNotUpgradableError(
        "level-up",
        "it has no marketplace entry to upgrade from",
      );
    });

    await expect(
      invokeUpgrade({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("PluginNotFoundError → NotFoundError (404)", async () => {
    upgradeSpy.mockImplementation(async () => {
      throw new PluginNotFoundError("level-up", "main", "vellum-ai/level-up");
    });

    await expect(
      invokeUpgrade({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PluginSourceUnavailableError → ServiceUnavailableError (503)", async () => {
    // The re-install fetch can hit a rate-limited GitHub; that is retryable,
    // so surface 503 rather than a misleading 500.
    upgradeSpy.mockImplementation(async () => {
      throw new PluginSourceUnavailableError(
        "GitHub tree listing for vellum-ai/level-up: HTTP 403",
        403,
      );
    });

    await expect(
      invokeUpgrade({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    upgradeSpy.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });

    let caught: unknown;
    try {
      await invokeUpgrade({ pathParams: { name: "level-up" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as Error).message).toContain("ECONNRESET");
  });
});
