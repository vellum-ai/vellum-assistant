/**
 * Tests for the plugins route handlers in `plugins-routes.ts`.
 *
 * GET /v1/plugins (list):
 *   - Projection from `InstalledPluginInfo` → response shape (id, name,
 *     description, version, path; issues + icon omitted when absent)
 *   - `?q=` substring filter (case-insensitive across id/name/description)
 *   - Trimming + empty-string fallthrough on `?q=`
 *   - Empty install dir → `{ plugins: [], categoryCounts: {}, totalCount: 0 }`
 *   - Issues array surfaced when present
 *   - `category` resolved from the marketplace catalog (null when unknown)
 *   - `categoryCounts` / `totalCount` computed before the `?category=` filter
 *   - `?category=` filters the list while counts stay unfiltered
 *   - A catalog fetch failure degrades `category` to null without erroring
 *
 * GET /v1/plugins/search (catalog search):
 *   - Resolves the catalog for `?ref=` and filters it by `?q=`
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
 *   - Publishes `sync_changed(plugins:list)` on success (threading the
 *     `x-vellum-client-id` origin); no broadcast on an error path
 *   - Maps `InvalidPluginNameError` → BadRequestError (400)
 *   - Maps `PluginNotInstalledError` → NotFoundError (404)
 *   - Maps unknown errors → InternalError (500) with message preserved
 *
 * POST /v1/plugins/:name/enable | disable (toggle):
 *   - Forwards `pathParams.name` to the `enablePlugin` / `disablePlugin` lib
 *   - Returns `{ ok: true }` and publishes a `sync_changed` carrying the
 *     `plugins:list` tag via the canonical resource-sync publisher (enable and
 *     disable emit the SAME invalidation)
 *   - Threads `x-vellum-client-id` into the published event's `originClientId`
 *   - A broadcast failure does not fail a successful toggle (the publisher
 *     swallows hub errors)
 *   - Maps `InvalidPluginNameError` → BadRequestError (400)
 *   - Maps `PluginDirectoryNotFoundError` → NotFoundError (404)
 *   - Maps `PluginAlreadyInStateException` → ConflictError (409); no broadcast
 *
 * The library functions themselves are covered by
 * `assistant/src/cli/lib/__tests__/list-installed-plugins.test.ts`,
 * `.../search-plugins.test.ts`, and `.../uninstall-plugin.test.ts`;
 * here we mock them to isolate the route's wiring logic.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type DiffPluginDeps,
  type DiffPluginOptions,
  type PluginDiffResult,
  PluginDiffUnavailableError,
} from "../../../cli/lib/diff-plugin.js";
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
  isFullCommitSha,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  sanitizePluginName,
} from "../../../cli/lib/install-from-github.js";
import type { InstalledPluginInfo } from "../../../cli/lib/list-installed-plugins.js";
import { DEFAULT_PIN_HISTORY_LIMIT } from "../../../cli/lib/plugin-constants.js";
import {
  type PluginDetails,
  PluginDetailsNotFoundError,
  type PluginDetailsOptions,
} from "../../../cli/lib/plugin-details.js";
import {
  type PluginPinHistoryEntry,
  PluginPinHistoryError,
} from "../../../cli/lib/plugin-pin-history.js";
import type {
  PluginCatalog,
  PluginSearchMatch,
  SearchPluginsDeps,
} from "../../../cli/lib/search-plugins.js";
import { PluginCatalogUnavailableError } from "../../../cli/lib/search-plugins.js";
import {
  InvalidPluginNameError as ToggleInvalidPluginNameError,
  PluginAlreadyInStateException,
  PluginDirectoryNotFoundError,
  type TogglePluginResult,
} from "../../../cli/lib/toggle-plugin.js";
import {
  PluginNotInstalledError,
  type UninstallPluginOptions,
  type UninstallPluginResult,
} from "../../../cli/lib/uninstall-plugin.js";
import {
  PluginMergeBaselineError,
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

// Set of plugin dir names carrying a `.disabled` sentinel. Tests populate it to
// mark a plugin disabled; the real check reads the workspace filesystem, so we
// substitute an in-memory set to keep the route's `enabled` projection
// deterministic and decoupled from disk.
const disabledFixture = new Set<string>();

mock.module("../../../plugins/disabled-state.js", () => ({
  isPluginDisabled: (name: string) => disabledFixture.has(name),
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
  (_opts: UninstallPluginOptions): Promise<UninstallPluginResult> => {
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
  // The icon route calls the real name guard directly (it builds a filesystem
  // path from `:name` rather than delegating to a lib that sanitizes), so pass
  // the real `sanitizePluginName` through — a traversal name must still 400.
  sanitizePluginName,
  // The (unmocked) catalog resolver enforces the full-SHA pin invariant via the
  // real `isFullCommitSha`, so pass it through rather than the default undefined.
  isFullCommitSha,
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
  PluginMergeBaselineError,
  PluginNotUpgradableError,
  upgradePlugin: upgradeSpy,
}));

// Mock diffPlugin: the lib re-materializes the install commit and computes the
// per-file unified diff (covered by diff-plugin.test.ts); the route forwards
// the name and maps the lib's error taxonomy to HTTP status codes.
const diffSpy = mock(
  async (
    _opts: DiffPluginOptions,
    _deps: DiffPluginDeps,
  ): Promise<PluginDiffResult> => {
    throw new Error("diffSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/diff-plugin.js", () => ({
  PluginDiffUnavailableError,
  diffPlugin: diffSpy,
}));

// Mock the pin-history lib: the GitHub commit-history walk is covered by
// plugin-pin-history.test.ts; the routes only forward the name, validate a pin
// against the resolved history, and map errors.
const listPinHistorySpy = mock(
  async (..._args: unknown[]): Promise<PluginPinHistoryEntry[]> => {
    throw new Error("listPinHistorySpy default impl not configured");
  },
);
const resolvePinSpy = mock(
  async (..._args: unknown[]): Promise<PluginPinHistoryEntry | null> => {
    throw new Error("resolvePinSpy default impl not configured");
  },
);

mock.module("../../../cli/lib/plugin-pin-history.js", () => ({
  DEFAULT_PIN_HISTORY_LIMIT,
  PluginPinHistoryError,
  listPinHistory: listPinHistorySpy,
  resolvePinToMarketplaceCommit: resolvePinSpy,
}));

// Mock the toggle-plugin lib. `enablePlugin` / `disablePlugin` flip a
// `.disabled` sentinel on disk in production; here we spy on them so the
// route's broadcast + error mapping is the wiring under test. The error
// classes pass through real so the handler's `instanceof` checks resolve to
// the same classes the spies throw.
const enablePluginSpy = mock((_name: string): TogglePluginResult => {
  throw new Error("enablePluginSpy default impl not configured");
});
const disablePluginSpy = mock((_name: string): TogglePluginResult => {
  throw new Error("disablePluginSpy default impl not configured");
});

mock.module("../../../cli/lib/toggle-plugin.js", () => ({
  InvalidPluginNameError: ToggleInvalidPluginNameError,
  PluginAlreadyInStateException,
  PluginDirectoryNotFoundError,
  disablePlugin: disablePluginSpy,
  enablePlugin: enablePluginSpy,
}));

// Spy on broadcastMessage so we can assert the sync_changed invalidation the
// enable/disable handlers emit. The handlers publish through the canonical
// `publishPluginsChanged` → `publishSyncInvalidation` path (both left real), so
// the spy receives the actual `{ type: "sync_changed", tags: [...],
// originClientId? }` payload the publisher builds.
const broadcastMessageSpy = mock((_msg: unknown): void => {});

mock.module("../../assistant-event-hub.js", () => ({
  broadcastMessage: broadcastMessageSpy,
}));

// Make the valid-slug source deterministic: the real `getLocalCategorySlugs`
// reads the bundled YAML (absent in the test sandbox), so we pin it to the
// authoritative Skills taxonomy. This decouples the route's category
// normalization from the filesystem / network.
const SKILLS_CATEGORY_SLUGS = new Set([
  "email",
  "calendar",
  "messaging",
  "browsing",
  "productivity",
  "development",
  "voice",
  "commerce",
  "content",
  "health",
  "system",
  "integrations",
]);

mock.module("../../../skills/categories-cache.js", () => ({
  getLocalCategorySlugs: () => SKILLS_CATEGORY_SLUGS,
}));

import { getWorkspacePluginsDir } from "../../../util/platform.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import {
  loadCategoryMapBounded,
  normalizeMarketplaceCategory,
  ROUTES as PLUGINS_ROUTES,
} from "../plugins-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";
import { RouteResponse } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = PLUGINS_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const listHandler = findHandler("plugins_list");
const searchHandler = findHandler("plugins_search");
const uninstallHandler = findHandler("plugins_uninstall");
const getHandler = findHandler("plugins_get");
const installHandler = findHandler("plugins_install");
const inspectHandler = findHandler("plugins_inspect");
const versionsHandler = findHandler("plugins_versions");
const upgradeHandler = findHandler("plugins_upgrade");
const diffHandler = findHandler("plugins_diff");
const enableHandler = findHandler("plugins_enable");
const disableHandler = findHandler("plugins_disable");
const iconHandler = findHandler("plugins_icon");

async function invoke(args: RouteHandlerArgs = {}): Promise<{
  plugins: Array<Record<string, unknown>>;
  categoryCounts: Record<string, number>;
  totalCount: number;
}> {
  return (await listHandler(args)) as {
    plugins: Array<Record<string, unknown>>;
    categoryCounts: Record<string, number>;
    totalCount: number;
  };
}

// The route wire shape mirrors the lib match — including `category`.
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
    hasIcon: overrides.hasIcon ?? false,
    ...(overrides.iconVersion !== undefined
      ? { iconVersion: overrides.iconVersion }
      : {}),
  };
}

beforeEach(() => {
  installedFixture = [];
  disabledFixture.clear();
});

describe("GET /v1/plugins", () => {
  beforeEach(() => {
    getCatalogSpy.mockClear();
    // Default to an empty catalog so every installed plugin's category resolves
    // to `null` (bucketed under "system"). Tests that exercise real categories
    // override this.
    getCatalogSpy.mockImplementation(async (ref) => catalog(ref, []));
  });

  test("returns an empty list (with empty counts) when nothing is installed", async () => {
    expect(await invoke()).toEqual({
      plugins: [],
      categoryCounts: {},
      totalCount: 0,
    });
    // Nothing to categorize → the network-bound catalog lookup is skipped.
    expect(getCatalogSpy).not.toHaveBeenCalled();
  });

  test("projects InstalledPluginInfo → response shape with all fields populated", async () => {
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

    const result = await invoke();
    expect(result.plugins).toHaveLength(1);
    // No catalog entry for `alpha`, so its category is null.
    expect(result.plugins[0]).toEqual({
      id: "alpha",
      name: "alpha",
      // No `.disabled` sentinel → the plugin is enabled.
      enabled: true,
      description: "Alpha plugin",
      version: "1.2.3",
      path: "/workspace/plugins/alpha",
      category: null,
      // No bundled `icon.png` on this fixture → hasIcon is false, iconVersion absent.
      hasIcon: false,
    });
    // `issues` is omitted (not just undefined) when the entry is clean.
    expect("issues" in result.plugins[0]!).toBe(false);
  });

  test("surfaces a marketplace category when the catalog declares one", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "alpha",
          path: "github:acme/alpha@v1",
          category: "productivity",
          source: { kind: "github", repo: "acme/alpha", ref: "v1" },
        },
      ]),
    );
    installedFixture = [
      pluginEntry({
        name: "alpha",
        packageJson: { name: "alpha", version: "1.2.3" },
      }),
    ];

    const [entry] = (await invoke()).plugins;
    expect(entry?.category).toBe("productivity");
  });

  test("uses directory name for `id` and `name` even when package.json#name is scoped", async () => {
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

    const [entry] = (await invoke()).plugins;
    expect(entry?.id).toBe("fancy-plugin");
    expect(entry?.name).toBe("fancy-plugin");
  });

  test("nulls description and version when package.json is missing or partial", async () => {
    installedFixture = [
      pluginEntry({ name: "no-pkg-json", packageJson: null }),
      pluginEntry({
        name: "partial",
        packageJson: { name: "partial" }, // no version / description
      }),
    ];

    const [missing, partial] = (await invoke()).plugins;
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

  test("surfaces non-fatal issues array when present", async () => {
    installedFixture = [
      pluginEntry({
        name: "broken",
        packageJson: null,
        issues: ["missing package.json"],
      }),
    ];

    const [entry] = (await invoke()).plugins;
    expect(entry?.issues).toEqual(["missing package.json"]);
  });

  test("serializes `icon` from vellum.icon, omitting it when absent", async () => {
    installedFixture = [
      pluginEntry({
        name: "with-icon",
        packageJson: { name: "with-icon", version: "1.0.0", icon: "🎨" },
      }),
      pluginEntry({
        name: "no-icon",
        packageJson: { name: "no-icon", version: "1.0.0" },
      }),
    ];

    const byId = new Map((await invoke()).plugins.map((p) => [p.id, p]));
    expect(byId.get("with-icon")?.icon).toBe("🎨");
    // Absent icon is omitted from the wire object, not set to undefined/null.
    expect("icon" in byId.get("no-icon")!).toBe(false);
  });

  test("serializes hasIcon + iconVersion from the validated bundled icon.png", async () => {
    installedFixture = [
      pluginEntry({
        name: "bundled",
        packageJson: { name: "bundled", version: "1.0.0" },
        hasIcon: true,
        iconVersion: "deadbeefdeadbeef",
      }),
      pluginEntry({
        name: "plain",
        packageJson: { name: "plain", version: "1.0.0" },
      }),
    ];

    const byId = new Map((await invoke()).plugins.map((p) => [p.id, p]));
    expect(byId.get("bundled")?.hasIcon).toBe(true);
    expect(byId.get("bundled")?.iconVersion).toBe("deadbeefdeadbeef");
    // No valid icon → hasIcon false and iconVersion omitted (not null).
    expect(byId.get("plain")?.hasIcon).toBe(false);
    expect("iconVersion" in byId.get("plain")!).toBe(false);
  });

  test("reports enabled: false for a plugin with a `.disabled` sentinel, true otherwise", async () => {
    installedFixture = [
      pluginEntry({ name: "off" }),
      pluginEntry({ name: "on" }),
    ];
    // Only `off` carries the sentinel; `on` has none.
    disabledFixture.add("off");

    const byId = new Map(
      (await invoke()).plugins.map((p) => [p.id, p.enabled]),
    );
    expect(byId.get("off")).toBe(false);
    expect(byId.get("on")).toBe(true);
  });

  test("?q= filters case-insensitively on id, name, and description", async () => {
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
      (await invoke({ queryParams: { q: "calendar" } })).plugins.map(
        (p) => p.id,
      ),
    ).toEqual(["calendar-sync"]);

    // description match (case-insensitive)
    expect(
      (await invoke({ queryParams: { q: "GOOGLE" } })).plugins.map((p) => p.id),
    ).toEqual(["calendar-sync"]);

    // matches multiple
    expect(
      (await invoke({ queryParams: { q: "o" } })).plugins
        .map((p) => p.id)
        .sort(),
    ).toEqual(["calendar-sync", "todo", "weather"].sort());

    // no match
    expect((await invoke({ queryParams: { q: "zzz" } })).plugins).toEqual([]);
  });

  test("?q= is trimmed; whitespace-only treated as no filter", async () => {
    installedFixture = [
      pluginEntry({ name: "alpha" }),
      pluginEntry({ name: "beta" }),
    ];

    expect(
      (await invoke({ queryParams: { q: "   " } })).plugins.map((p) => p.id),
    ).toEqual(["alpha", "beta"]);
  });

  test("preserves the order returned by listInstalledPlugins", async () => {
    installedFixture = [
      pluginEntry({ name: "alpha" }),
      pluginEntry({ name: "beta" }),
      pluginEntry({ name: "zeta" }),
    ];

    expect((await invoke()).plugins.map((p) => p.id)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test('reports categoryCounts + totalCount, bucketing unknown plugins under "system"', async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "calendar-sync",
          path: "github:acme/calendar-sync@v1",
          category: "calendar",
          source: { kind: "github", repo: "acme/calendar-sync", ref: "v1" },
        },
      ]),
    );
    installedFixture = [
      pluginEntry({ name: "calendar-sync" }),
      // Not in the catalog → category null → counted under "system".
      pluginEntry({ name: "mystery" }),
    ];

    const result = await invoke();
    expect(result.totalCount).toBe(2);
    expect(result.categoryCounts).toEqual({ calendar: 1, system: 1 });
    expect(result.plugins.find((p) => p.id === "calendar-sync")?.category).toBe(
      "calendar",
    );
    expect(result.plugins.find((p) => p.id === "mystery")?.category).toBeNull();
  });

  test("?category= filters the list while categoryCounts stays unfiltered", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "notes",
          path: "github:acme/notes@v1",
          category: "productivity",
          source: { kind: "github", repo: "acme/notes", ref: "v1" },
        },
        {
          name: "inbox",
          path: "github:acme/inbox@v1",
          category: "email",
          source: { kind: "github", repo: "acme/inbox", ref: "v1" },
        },
      ]),
    );
    installedFixture = [
      pluginEntry({ name: "notes" }),
      pluginEntry({ name: "inbox" }),
      // No catalog entry → "system".
      pluginEntry({ name: "loose" }),
    ];

    const result = await invoke({ queryParams: { category: "productivity" } });
    // The list is filtered to the productivity bucket...
    expect(result.plugins.map((p) => p.id)).toEqual(["notes"]);
    // ...but the badge counts reflect the unfiltered totals.
    expect(result.categoryCounts).toEqual({
      productivity: 1,
      email: 1,
      system: 1,
    });
    expect(result.totalCount).toBe(3);
  });

  test("degrades to category: null without failing when the catalog fetch throws", async () => {
    getCatalogSpy.mockImplementation(async () => {
      throw new PluginCatalogUnavailableError("HTTP 403", 403);
    });
    installedFixture = [
      pluginEntry({ name: "alpha" }),
      pluginEntry({ name: "beta" }),
    ];

    const result = await invoke();
    expect(result.plugins.map((p) => p.category)).toEqual([null, null]);
    expect(result.categoryCounts).toEqual({ system: 2 });
    expect(result.totalCount).toBe(2);
  });

  // The category lookup is bounded so a slow/hanging marketplace fetch (a cold
  // cache stuck on GitHub) can't hold up the installed list — it degrades to an
  // empty map exactly like the rejection path above. `loadCategoryMapBounded`
  // takes an injectable timeout so we can prove the bound without waiting the
  // full 1500ms production budget.
  test("bounds the catalog lookup: a stall past the budget degrades to an empty map", async () => {
    // GIVEN a catalog fetch that resolves only AFTER the (shortened) budget.
    getCatalogSpy.mockImplementation(
      (ref) =>
        new Promise<PluginCatalog>((resolve) => {
          setTimeout(
            () =>
              resolve(
                catalog(ref, [
                  {
                    name: "alpha",
                    path: "github:acme/alpha@v1",
                    category: "productivity",
                    source: { kind: "github", repo: "acme/alpha", ref: "v1" },
                  },
                ]),
              ),
            80,
          );
        }),
    );

    // WHEN the bound (10ms) elapses first, the timer wins the race.
    const map = await loadCategoryMapBounded(10);

    // THEN we fall back to an empty map, so every category resolves to null and
    // the installed list returns immediately instead of blocking on GitHub.
    expect(map.size).toBe(0);
  });

  test("returns the catalog category map when the lookup resolves within the budget", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "alpha",
          path: "github:acme/alpha@v1",
          category: "productivity",
          source: { kind: "github", repo: "acme/alpha", ref: "v1" },
        },
      ]),
    );

    const map = await loadCategoryMapBounded();
    expect(map.get("alpha")).toBe("productivity");
  });

  test("normalizes a `developer` marketplace category to `development`", async () => {
    // The marketplace ships `developer`, which is NOT a Skills slug; without
    // normalization it would be counted in "All" but have no rail row.
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "dev-tools",
          path: "github:acme/dev-tools@v1",
          category: "developer",
          source: { kind: "github", repo: "acme/dev-tools", ref: "v1" },
        },
      ]),
    );
    installedFixture = [pluginEntry({ name: "dev-tools" })];

    const result = await invoke();
    expect(result.plugins[0]?.category).toBe("development");
    expect(result.categoryCounts).toEqual({ development: 1 });
  });

  test("folds an unknown marketplace category (`memory`) to null → system", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "simple-memory",
          path: "github:acme/simple-memory@v1",
          category: "memory",
          source: { kind: "github", repo: "acme/simple-memory", ref: "v1" },
        },
      ]),
    );
    installedFixture = [pluginEntry({ name: "simple-memory" })];

    const result = await invoke();
    expect(result.plugins[0]?.category).toBeNull();
    expect(result.categoryCounts).toEqual({ system: 1 });
  });

  test("?category=development selects a `developer`-origin plugin (post-normalization)", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "dev-tools",
          path: "github:acme/dev-tools@v1",
          category: "developer",
          source: { kind: "github", repo: "acme/dev-tools", ref: "v1" },
        },
      ]),
    );
    installedFixture = [pluginEntry({ name: "dev-tools" })];

    const result = await invoke({ queryParams: { category: "development" } });
    expect(result.plugins.map((p) => p.id)).toEqual(["dev-tools"]);
  });

  test("?category=memory selects nothing — there is no such Skills slug", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "simple-memory",
          path: "github:acme/simple-memory@v1",
          category: "memory",
          source: { kind: "github", repo: "acme/simple-memory", ref: "v1" },
        },
      ]),
    );
    installedFixture = [pluginEntry({ name: "simple-memory" })];

    const result = await invoke({ queryParams: { category: "memory" } });
    expect(result.plugins).toEqual([]);
    // The plugin is still counted (under "system"), just not reachable as
    // "memory" — counts match visible rows.
    expect(result.categoryCounts).toEqual({ system: 1 });
  });
});

// ---------------------------------------------------------------------------
// normalizeMarketplaceCategory (unit)
// ---------------------------------------------------------------------------

describe("normalizeMarketplaceCategory", () => {
  test("passes a valid Skills slug through unchanged", () => {
    expect(
      normalizeMarketplaceCategory("productivity", SKILLS_CATEGORY_SLUGS),
    ).toBe("productivity");
  });

  test("aliases `developer` → `development`", () => {
    expect(
      normalizeMarketplaceCategory("developer", SKILLS_CATEGORY_SLUGS),
    ).toBe("development");
  });

  test("folds unknown marketplace slugs to null", () => {
    for (const unknown of ["memory", "interface", "marketing", "hobby"]) {
      expect(
        normalizeMarketplaceCategory(unknown, SKILLS_CATEGORY_SLUGS),
      ).toBeNull();
    }
  });

  test("treats null / empty / whitespace as null", () => {
    expect(
      normalizeMarketplaceCategory(null, SKILLS_CATEGORY_SLUGS),
    ).toBeNull();
    expect(
      normalizeMarketplaceCategory(undefined, SKILLS_CATEGORY_SLUGS),
    ).toBeNull();
    expect(normalizeMarketplaceCategory("", SKILLS_CATEGORY_SLUGS)).toBeNull();
    expect(
      normalizeMarketplaceCategory("   ", SKILLS_CATEGORY_SLUGS),
    ).toBeNull();
  });

  test("normalizes case + surrounding whitespace before matching", () => {
    expect(
      normalizeMarketplaceCategory("  Developer  ", SKILLS_CATEGORY_SLUGS),
    ).toBe("development");
    expect(
      normalizeMarketplaceCategory("PRODUCTIVITY", SKILLS_CATEGORY_SLUGS),
    ).toBe("productivity");
  });

  test("an empty valid-slug set folds every category to null", () => {
    expect(normalizeMarketplaceCategory("productivity", new Set())).toBeNull();
    expect(normalizeMarketplaceCategory("developer", new Set())).toBeNull();
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
          category: "productivity",
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
          category: null,
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
    // only `simple-memory`. The source discriminator and the marketplace
    // `category` both flow through to the wire.
    expect(result).toEqual({
      query: "^simple",
      ref: "my-feature-branch",
      matches: [
        {
          name: "simple-memory",
          path: "github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
          category: "productivity",
          source: {
            kind: "github",
            repo: "vellum-ai/simple-memory",
            ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
          },
        },
      ],
    });
  });

  test("normalizes match categories to the Skills taxonomy (`developer` → `development`, `hobby` → null)", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "dev-tools",
          path: "github:acme/dev-tools@v1",
          category: "developer",
          source: { kind: "github", repo: "acme/dev-tools", ref: "v1" },
        },
        {
          name: "snake-game",
          path: "github:acme/snake-game@v1",
          category: "hobby",
          source: { kind: "github", repo: "acme/snake-game", ref: "v1" },
        },
      ]),
    );

    const result = await invokeSearch();
    const byName = new Map(result.matches.map((m) => [m.name, m.category]));
    // `developer` is aliased to the Skills slug; `hobby` has no equivalent and
    // folds to null so "Available" filters against the same taxonomy.
    expect(byName.get("dev-tools")).toBe("development");
    expect(byName.get("snake-game")).toBeNull();
  });

  test("missing ?q= matches all (empty-string query) at the default ref", async () => {
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [
        {
          name: "caveman",
          path: "github:JuliusBrussee/caveman@v1.8.2",
          category: null,
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
    // An entry that declares no category surfaces as `category: null`.
    expect(result.matches[0]?.category).toBeNull();
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
        category: null,
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
        category: null,
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

async function invokeUninstall(
  args: RouteHandlerArgs = {},
): Promise<{ name: string; target: string }> {
  return (await uninstallHandler(args)) as { name: string; target: string };
}

describe("DELETE /v1/plugins/:name", () => {
  beforeEach(() => {
    uninstallSpy.mockReset();
    broadcastMessageSpy.mockReset();
  });

  test("forwards pathParams.name to uninstallPlugin and returns its result", async () => {
    uninstallSpy.mockImplementation(async (opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
    }));

    const result = await invokeUninstall({
      pathParams: { name: "simple-memory" },
    });

    expect(uninstallSpy.mock.calls).toHaveLength(1);
    expect(uninstallSpy.mock.calls[0]?.[0]).toEqual({ name: "simple-memory" });
    expect(result).toEqual({
      name: "simple-memory",
      target: "/workspace/.vellum/plugins/simple-memory",
    });
  });

  test("publishes sync_changed(plugins:list) on a successful uninstall", async () => {
    uninstallSpy.mockImplementation(async (opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
    }));

    await invokeUninstall({ pathParams: { name: "simple-memory" } });

    expectPluginsListBroadcast();
  });

  test("threads x-vellum-client-id into the published event's originClientId", async () => {
    uninstallSpy.mockImplementation(async (opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
    }));

    await invokeUninstall({
      pathParams: { name: "simple-memory" },
      headers: { "x-vellum-client-id": "client-abc" },
    });

    const [msg] = broadcastMessageSpy.mock.calls[0]!;
    expect(msg).toMatchObject({
      type: "sync_changed",
      originClientId: "client-abc",
    });
  });

  test("missing pathParams.name passes the empty string through to the lib", async () => {
    // The lib's `sanitizePluginName` is the validator of last resort —
    // the route hands off the raw value without pre-trimming. The lib
    // rejects empty strings, which the handler maps to 400 below.
    uninstallSpy.mockImplementation(() => {
      throw new InvalidPluginNameError(
        'Invalid plugin name "" — must match /^[a-z][a-z0-9-]{0,63}$/.',
      );
    });

    await expect(invokeUninstall({})).rejects.toThrow(BadRequestError);
    expect(uninstallSpy.mock.calls[0]?.[0]).toEqual({ name: "" });
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    uninstallSpy.mockImplementation(() => {
      throw new InvalidPluginNameError("bad name ../escape");
    });

    await expect(
      invokeUninstall({ pathParams: { name: "../escape" } }),
    ).rejects.toThrow(BadRequestError);
  });

  test("PluginNotInstalledError → NotFoundError (404), no broadcast", async () => {
    uninstallSpy.mockImplementation((opts) => {
      throw new PluginNotInstalledError(
        opts.name,
        `/workspace/.vellum/plugins/${opts.name}`,
      );
    });

    await expect(
      invokeUninstall({ pathParams: { name: "ghost" } }),
    ).rejects.toThrow(NotFoundError);
    // A failed uninstall must not fan out a spurious invalidation.
    expect(broadcastMessageSpy).not.toHaveBeenCalled();
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    uninstallSpy.mockImplementation(() => {
      throw new Error("EBUSY: resource busy or locked");
    });

    await expect(
      invokeUninstall({ pathParams: { name: "simple-memory" } }),
    ).rejects.toThrow(InternalError);
    await expect(
      invokeUninstall({ pathParams: { name: "simple-memory" } }),
    ).rejects.toThrow("EBUSY");
  });

  test("non-Error throws fall through to InternalError with a default message", async () => {
    uninstallSpy.mockImplementation(() => {
      throw "boom"; // emulates a poorly-typed throwable from the lib chain
    });

    let caught: unknown;
    try {
      await invokeUninstall({ pathParams: { name: "simple-memory" } });
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
    icon: overrides.icon ?? null,
    hasIcon: overrides.hasIcon ?? false,
    iconVersion: overrides.iconVersion ?? null,
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

// A gated-catalog match for `caveman` pinned to an immutable full commit SHA —
// the shape the resolver projects onto trusted install coordinates. Mirrors the
// bundled manifest: platform-first live, or the bundled pin when platform
// features are off.
const CAVEMAN_PIN = "63a91ecadbf4c4719a4602a5abb00883f9966034";
const CAVEMAN_CATALOG_MATCH: PluginSearchMatch = {
  name: "caveman",
  path: `github:JuliusBrussee/caveman@${CAVEMAN_PIN}`,
  description: "Ultra-compressed communication mode.",
  category: null,
  source: { kind: "github", repo: "JuliusBrussee/caveman", ref: CAVEMAN_PIN },
};

// installPlugin result for a trustedSource install: the returned `ref` is the
// trusted pin (the external content commit), not the default branch.
function trustedInstallResult(opts: InstallPluginOptions): InstallPluginResult {
  return {
    name: opts.name,
    target: `/workspace/.vellum/plugins/${opts.name}`,
    fileCount: 7,
    ref: opts.trustedSource?.ref ?? opts.ref ?? "main",
    commit: opts.trustedSource?.ref ?? null,
    committedAt: null,
  };
}

describe("POST /v1/plugins/install", () => {
  beforeEach(() => {
    installSpy.mockReset();
    resolvePinSpy.mockReset();
    broadcastMessageSpy.mockReset();
    getCatalogSpy.mockReset();
    // Default: the gated catalog resolves `caveman` to its bundled full-SHA pin.
    getCatalogSpy.mockImplementation(async (ref) =>
      catalog(ref, [CAVEMAN_CATALOG_MATCH]),
    );
  });

  test("no-pin install resolves from the gated catalog and installs via trustedSource", async () => {
    // The default (no-pin) path reads the same gated catalog `search`
    // advertises and installs from a trusted pre-resolved source — no direct
    // `plugins/marketplace.json` fetch (the pin/marketplace path is untouched).
    const prev = process.env.VELLUM_DISABLE_PLATFORM;
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    try {
      installSpy.mockImplementation(async (opts) => trustedInstallResult(opts));

      const result = await invokeInstall({
        body: { name: "caveman", force: true },
      });

      // Resolved through the gated catalog, not the pin/marketplace path.
      expect(getCatalogSpy).toHaveBeenCalledTimes(1);
      expect(resolvePinSpy).not.toHaveBeenCalled();
      // installPlugin receives the pre-resolved trusted coordinates (owner/repo
      // split from the catalog `repo`, `rootPath` from its path, the full-SHA
      // pin as `ref`) — no caller-supplied `ref`.
      expect(installSpy.mock.calls[0]?.[0]).toEqual({
        name: "caveman",
        force: true,
        trustedSource: {
          owner: "JuliusBrussee",
          repo: "caveman",
          rootPath: "",
          ref: CAVEMAN_PIN,
        },
      });
      expect(result).toEqual({
        ok: true,
        name: "caveman",
        target: "/workspace/.vellum/plugins/caveman",
        fileCount: 7,
        ref: CAVEMAN_PIN,
      });
    } finally {
      if (prev === undefined) {
        delete process.env.VELLUM_DISABLE_PLATFORM;
      } else {
        process.env.VELLUM_DISABLE_PLATFORM = prev;
      }
    }
  });

  test("publishes sync_changed(plugins:list) on a successful install", async () => {
    installSpy.mockImplementation(async (opts) => trustedInstallResult(opts));

    await invokeInstall({ body: { name: "caveman" } });

    expectPluginsListBroadcast();
  });

  test("threads x-vellum-client-id into the published event's originClientId", async () => {
    installSpy.mockImplementation(async (opts) => trustedInstallResult(opts));

    await invokeInstall({
      body: { name: "caveman" },
      headers: { "x-vellum-client-id": "client-abc" },
    });

    const [msg] = broadcastMessageSpy.mock.calls[0]!;
    expect(msg).toMatchObject({
      type: "sync_changed",
      originClientId: "client-abc",
    });
  });

  test("ignores a caller-supplied ref and installs from the catalog-resolved source", async () => {
    // Security boundary: installing from an unreviewed ref (a PR branch,
    // fork ref, ...) could load attacker-controlled code, so the HTTP route
    // never honors a body `ref` — the no-pin source comes only from the gated
    // catalog.
    installSpy.mockImplementation(async (opts) => trustedInstallResult(opts));

    const result = await invokeInstall({
      body: { name: "caveman", ref: "attacker-pr-branch" },
    });

    expect(result.ref).toBe(CAVEMAN_PIN);
    expect(installSpy.mock.calls[0]?.[0]).toEqual({
      name: "caveman",
      force: undefined,
      trustedSource: {
        owner: "JuliusBrussee",
        repo: "caveman",
        rootPath: "",
        ref: CAVEMAN_PIN,
      },
    });
  });

  test("an unknown name (no pin) → NotFoundError (404), no install", async () => {
    // The catalog claims no such plugin, so the resolver returns null.
    getCatalogSpy.mockImplementation(async (ref) => catalog(ref, []));

    await expect(
      invokeInstall({ body: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(installSpy).not.toHaveBeenCalled();
  });

  test("a catalog outage on the no-pin path → ServiceUnavailableError (503)", async () => {
    // A rate-limited or unavailable platform catalog (no stale fallback) is
    // transient — the route surfaces it as retryable, not a misleading 500.
    getCatalogSpy.mockImplementation(async () => {
      throw new PluginCatalogUnavailableError("HTTP 403", 403);
    });

    await expect(
      invokeInstall({ body: { name: "caveman" } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(installSpy).not.toHaveBeenCalled();
  });

  test("a missing name short-circuits to BadRequestError without calling the lib", async () => {
    await expect(invokeInstall({ body: {} })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(installSpy).not.toHaveBeenCalled();
    expect(getCatalogSpy).not.toHaveBeenCalled();
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    installSpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("bad plugin name");
    });

    await expect(
      invokeInstall({ body: { name: "caveman" } }),
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

  test("PluginNotFoundError → NotFoundError (404), no broadcast", async () => {
    installSpy.mockImplementation(async (opts) => {
      throw new PluginNotFoundError(opts.name, "main", "example-org/ghost");
    });

    await expect(
      invokeInstall({ body: { name: "caveman" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A failed install must not fan out a spurious invalidation.
    expect(broadcastMessageSpy).not.toHaveBeenCalled();
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

  test("a reviewed pin installs from the marketplace commit that introduced it", async () => {
    // GIVEN a pin that resolves to a marketplace commit in the reviewed history
    resolvePinSpy.mockImplementation(async () => ({
      pin: "a".repeat(40),
      marketplaceCommit: "f".repeat(40),
      promotedAt: "2026-06-01T00:00:00.000Z",
      current: false,
    }));
    installSpy.mockImplementation(async (opts) => ({
      name: opts.name,
      target: `/workspace/.vellum/plugins/${opts.name}`,
      fileCount: 7,
      ref: opts.ref ?? "main",
      commit: "a".repeat(40),
      committedAt: null,
    }));

    const result = await invokeInstall({
      body: { name: "caveman", pin: "a".repeat(40) },
    });

    // THEN the install reads the manifest at the resolving marketplace commit,
    // not the default branch, and the gated catalog resolver is bypassed — the
    // pin path stays on the reviewed pin-history/GitHub route.
    expect(getCatalogSpy).not.toHaveBeenCalled();
    expect(installSpy.mock.calls[0]?.[0]).toEqual({
      name: "caveman",
      ref: "f".repeat(40),
      force: undefined,
    });
    expect(result.ref).toBe("f".repeat(40));
  });

  test("an unreviewed pin is refused as a BadRequest before installing", async () => {
    resolvePinSpy.mockImplementation(async () => null);

    await expect(
      invokeInstall({ body: { name: "caveman", pin: "b".repeat(40) } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(installSpy).not.toHaveBeenCalled();
  });

  test("a pin-history read failure surfaces as ServiceUnavailable (503)", async () => {
    resolvePinSpy.mockImplementation(async () => {
      throw new PluginPinHistoryError("HTTP 403");
    });

    await expect(
      invokeInstall({ body: { name: "caveman", pin: "c".repeat(40) } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(installSpy).not.toHaveBeenCalled();
  });
});

describe("GET /v1/plugins/:name/versions", () => {
  beforeEach(() => {
    listPinHistorySpy.mockReset();
  });

  test("returns the resolved pin history", async () => {
    const history: PluginPinHistoryEntry[] = [
      {
        pin: "c".repeat(40),
        marketplaceCommit: "3".repeat(40),
        promotedAt: "2026-06-10T00:00:00.000Z",
        current: true,
      },
      {
        pin: "a".repeat(40),
        marketplaceCommit: "1".repeat(40),
        promotedAt: "2026-06-01T00:00:00.000Z",
        current: false,
      },
    ];
    listPinHistorySpy.mockImplementation(async () => history);

    const result = await versionsHandler({ pathParams: { name: "level-up" } });
    expect(result).toEqual(history);
  });

  test("forwards a positive limit to the lib", async () => {
    listPinHistorySpy.mockImplementation(async () => []);
    await versionsHandler({
      pathParams: { name: "level-up" },
      queryParams: { limit: "3" },
    });
    expect(listPinHistorySpy.mock.calls[0]?.[2]).toEqual({ limit: 3 });
  });

  test("rejects a non-positive limit as BadRequest before calling the lib", async () => {
    await expect(
      versionsHandler({
        pathParams: { name: "level-up" },
        queryParams: { limit: "0" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(listPinHistorySpy).not.toHaveBeenCalled();
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    listPinHistorySpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("../escape");
    });
    await expect(
      versionsHandler({ pathParams: { name: "../escape" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("PluginPinHistoryError → ServiceUnavailableError (503)", async () => {
    listPinHistorySpy.mockImplementation(async () => {
      throw new PluginPinHistoryError("HTTP 429");
    });
    await expect(
      versionsHandler({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
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
    surfaces:
      overrides.surfaces === undefined
        ? { skills: [], hooks: ["post-model-call"], tools: [] }
        : overrides.surfaces,
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
    strategy: overrides.strategy ?? "overwrite",
    conflicts: overrides.conflicts ?? [],
    binaryConflicts: overrides.binaryConflicts ?? [],
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
  strategy: string;
  conflicts: readonly string[];
  binaryConflicts: readonly string[];
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
    strategy: string;
    conflicts: readonly string[];
    binaryConflicts: readonly string[];
    provenanceWasUnknown: boolean;
  };
}

describe("POST /v1/plugins/:name/upgrade", () => {
  beforeEach(() => {
    upgradeSpy.mockReset();
    broadcastMessageSpy.mockReset();
  });

  test("publishes sync_changed(plugins:list) on a successful upgrade", async () => {
    upgradeSpy.mockImplementation(async () => upgradeResult());

    await invokeUpgrade({ pathParams: { name: "level-up" } });

    expectPluginsListBroadcast();
  });

  test("threads x-vellum-client-id into the published event's originClientId", async () => {
    upgradeSpy.mockImplementation(async () => upgradeResult());

    await invokeUpgrade({
      pathParams: { name: "level-up" },
      headers: { "x-vellum-client-id": "client-abc" },
    });

    const [msg] = broadcastMessageSpy.mock.calls[0]!;
    expect(msg).toMatchObject({
      type: "sync_changed",
      originClientId: "client-abc",
    });
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
      strategy: "overwrite",
      conflicts: [],
      binaryConflicts: [],
      provenanceWasUnknown: false,
    });
    // AND the name + dryRun are forwarded to the lib (strategy omitted)
    expect(upgradeSpy.mock.calls[0]?.[0]).toEqual({
      name: "level-up",
      dryRun: false,
      strategy: undefined,
    });
  });

  test("forwards a requested strategy to the lib and projects it", async () => {
    // GIVEN upgradePlugin merges local edits forward via the `ours` strategy
    upgradeSpy.mockImplementation(async () =>
      upgradeResult({ strategy: "ours" }),
    );

    // WHEN the handler runs with a strategy in the body
    const result = await invokeUpgrade({
      pathParams: { name: "level-up" },
      body: { strategy: "ours" },
    });

    // THEN the strategy is forwarded to the lib and surfaced on the wire
    expect(result.strategy).toBe("ours");
    expect(upgradeSpy.mock.calls[0]?.[0]).toEqual({
      name: "level-up",
      dryRun: undefined,
      strategy: "ours",
    });
  });

  test("projects conflicts + binaryConflicts from the assistant strategy onto the wire", async () => {
    // GIVEN upgradePlugin merges with conflict markers under `assistant`
    upgradeSpy.mockImplementation(async () =>
      upgradeResult({
        strategy: "assistant",
        conflicts: ["hooks/post-model-call.ts"],
        binaryConflicts: ["assets/icon.png"],
      }),
    );

    // WHEN the handler runs with the `assistant` strategy
    const result = await invokeUpgrade({
      pathParams: { name: "level-up" },
      body: { strategy: "assistant" },
    });

    // THEN the conflicted paths are surfaced for the assistant to resolve
    expect(result.strategy).toBe("assistant");
    expect(result.conflicts).toEqual(["hooks/post-model-call.ts"]);
    expect(result.binaryConflicts).toEqual(["assets/icon.png"]);
    expect(upgradeSpy.mock.calls[0]?.[0]).toEqual({
      name: "level-up",
      dryRun: undefined,
      strategy: "assistant",
    });
  });

  test("PluginMergeBaselineError \u2192 ConflictError (409)", async () => {
    // A merge strategy whose install-time baseline can't be reconstructed: a
    // well-formed request that isn't actionable in the current state.
    upgradeSpy.mockImplementation(async () => {
      throw new PluginMergeBaselineError(
        "level-up",
        "the install-time baseline could not be faithfully reconstructed",
      );
    });

    await expect(
      invokeUpgrade({
        pathParams: { name: "level-up" },
        body: { strategy: "ours" },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
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

  test("PluginNotInstalledError → NotFoundError (404), no broadcast", async () => {
    upgradeSpy.mockImplementation(async () => {
      throw new PluginNotInstalledError(
        "ghost",
        "/workspace/.vellum/plugins/ghost",
      );
    });

    await expect(
      invokeUpgrade({ pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A failed upgrade must not fan out a spurious invalidation.
    expect(broadcastMessageSpy).not.toHaveBeenCalled();
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

function diffResult(
  overrides: Partial<PluginDiffResult> = {},
): PluginDiffResult {
  return {
    name: overrides.name ?? "level-up",
    target: overrides.target ?? "/workspace/.vellum/plugins/level-up",
    commit: overrides.commit ?? "60a392b0000000000000000000000000000000aa",
    committedAt: overrides.committedAt ?? "2026-06-01T12:34:56.000Z",
    clean: overrides.clean ?? false,
    files: overrides.files ?? [
      {
        path: "src/skill.ts",
        status: "modified",
        diff: "--- a/src/skill.ts\n+++ b/src/skill.ts\n@@ -1 +1 @@\n-old\n+new\n",
        binary: false,
        reconstructed: true,
      },
    ],
  };
}

async function invokeDiff(
  args: RouteHandlerArgs = {},
): Promise<PluginDiffResult> {
  return (await diffHandler(args)) as PluginDiffResult;
}

describe("POST /v1/plugins/:name/diff", () => {
  beforeEach(() => {
    diffSpy.mockReset();
  });

  test("forwards the name to diffPlugin and returns the diff verbatim", async () => {
    // GIVEN diffPlugin reports a single modified file against the install commit
    const view = diffResult();
    diffSpy.mockImplementation(async () => view);

    // WHEN the route handler is invoked with the path name
    const result = await invokeDiff({ pathParams: { name: "level-up" } });

    // THEN the diff is returned unchanged
    expect(result).toEqual(view);
    // AND only the name is forwarded to the lib (ref is never caller-supplied)
    expect(diffSpy.mock.calls[0]?.[0]).toEqual({ name: "level-up" });
  });

  test("InvalidPluginNameError → BadRequestError (400)", async () => {
    diffSpy.mockImplementation(async () => {
      throw new InvalidPluginNameError("../escape");
    });

    await expect(
      invokeDiff({ pathParams: { name: "../escape" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("PluginNotInstalledError → NotFoundError (404)", async () => {
    diffSpy.mockImplementation(async () => {
      throw new PluginNotInstalledError(
        "ghost",
        "/workspace/.vellum/plugins/ghost",
      );
    });

    await expect(
      invokeDiff({ pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PluginNotFoundError → NotFoundError (404)", async () => {
    // The recorded commit no longer resolves to a tree (source/commit gone).
    diffSpy.mockImplementation(async () => {
      throw new PluginNotFoundError(
        "level-up",
        "deadbeef",
        "vellum-ai/level-up",
      );
    });

    await expect(
      invokeDiff({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PluginDiffUnavailableError → ConflictError (409)", async () => {
    // The install recorded no commit, so there is no baseline to diff against:
    // a well-formed request that is not actionable in the current state.
    diffSpy.mockImplementation(async () => {
      throw new PluginDiffUnavailableError(
        "level-up",
        "no install commit was recorded",
      );
    });

    await expect(
      invokeDiff({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("PluginSourceUnavailableError → ServiceUnavailableError (503)", async () => {
    // Re-materializing the baseline can hit a rate-limited/down GitHub; that is
    // retryable, so surface 503 rather than a misleading 500.
    diffSpy.mockImplementation(async () => {
      throw new PluginSourceUnavailableError(
        "git clone failed for vellum-ai/level-up: HTTP 403",
        503,
      );
    });

    await expect(
      invokeDiff({ pathParams: { name: "level-up" } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("unknown errors → InternalError with original message preserved", async () => {
    diffSpy.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });

    let caught: unknown;
    try {
      await invokeDiff({ pathParams: { name: "level-up" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as Error).message).toContain("ECONNRESET");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/plugins/:name/enable | disable (toggle)
// ---------------------------------------------------------------------------

function toggleResult(
  name: string,
  action: "enable" | "disable",
): TogglePluginResult {
  return {
    name,
    action,
    sentinelPath: `/workspace/.vellum/plugins/${name}/.disabled`,
  };
}

function invokeEnable(args: RouteHandlerArgs = {}): { ok: boolean } {
  return enableHandler(args) as { ok: boolean };
}

function invokeDisable(args: RouteHandlerArgs = {}): { ok: boolean } {
  return disableHandler(args) as { ok: boolean };
}

/** Assert the spy received exactly one sync_changed carrying `plugins:list`. */
function expectPluginsListBroadcast(): void {
  expect(broadcastMessageSpy.mock.calls).toHaveLength(1);
  const [msg] = broadcastMessageSpy.mock.calls[0]!;
  expect(msg).toMatchObject({ type: "sync_changed" });
  expect((msg as { tags: string[] }).tags).toContain("plugins:list");
}

describe("POST /v1/plugins/:name/enable", () => {
  beforeEach(() => {
    enablePluginSpy.mockReset();
    broadcastMessageSpy.mockReset();
  });

  test("enables the plugin and broadcasts sync_changed(plugins:list)", () => {
    enablePluginSpy.mockImplementation((name) => toggleResult(name, "enable"));

    const result = invokeEnable({ pathParams: { name: "simple-memory" } });

    expect(result).toEqual({ ok: true });
    expect(enablePluginSpy.mock.calls[0]?.[0]).toBe("simple-memory");
    expectPluginsListBroadcast();
  });

  test("threads x-vellum-client-id into the published event's originClientId", () => {
    enablePluginSpy.mockImplementation((name) => toggleResult(name, "enable"));

    invokeEnable({
      pathParams: { name: "simple-memory" },
      headers: { "x-vellum-client-id": "client-abc" },
    });

    // The initiating client's id flows through the canonical publisher so it
    // can self-echo-suppress its own invalidation.
    const [msg] = broadcastMessageSpy.mock.calls[0]!;
    expect(msg).toMatchObject({
      type: "sync_changed",
      originClientId: "client-abc",
    });
  });

  test("a broadcast failure does not fail a successful toggle", () => {
    enablePluginSpy.mockImplementation((name) => toggleResult(name, "enable"));
    // The sentinel was already flipped; a hub throw AFTER that must not surface
    // as a 500 — the canonical publisher swallows broadcast errors.
    broadcastMessageSpy.mockImplementation(() => {
      throw new Error("hub unavailable");
    });

    const result = invokeEnable({ pathParams: { name: "simple-memory" } });
    expect(result).toEqual({ ok: true });
  });

  test("PluginAlreadyInStateException → ConflictError (409), no broadcast", () => {
    enablePluginSpy.mockImplementation((name) => {
      throw new PluginAlreadyInStateException(name, "enable");
    });

    expect(() =>
      invokeEnable({ pathParams: { name: "simple-memory" } }),
    ).toThrow(ConflictError);
    // A no-op toggle must not fan out a spurious invalidation.
    expect(broadcastMessageSpy).not.toHaveBeenCalled();
  });

  test("PluginDirectoryNotFoundError → NotFoundError (404)", () => {
    enablePluginSpy.mockImplementation((name) => {
      throw new PluginDirectoryNotFoundError(name);
    });

    expect(() => invokeEnable({ pathParams: { name: "ghost" } })).toThrow(
      NotFoundError,
    );
  });

  test("InvalidPluginNameError → BadRequestError (400)", () => {
    enablePluginSpy.mockImplementation(() => {
      throw new ToggleInvalidPluginNameError("../escape");
    });

    expect(() => invokeEnable({ pathParams: { name: "../escape" } })).toThrow(
      BadRequestError,
    );
  });
});

describe("POST /v1/plugins/:name/disable", () => {
  beforeEach(() => {
    disablePluginSpy.mockReset();
    broadcastMessageSpy.mockReset();
  });

  test("disables the plugin and broadcasts sync_changed(plugins:list)", () => {
    disablePluginSpy.mockImplementation((name) =>
      toggleResult(name, "disable"),
    );

    const result = invokeDisable({ pathParams: { name: "simple-memory" } });

    expect(result).toEqual({ ok: true });
    expect(disablePluginSpy.mock.calls[0]?.[0]).toBe("simple-memory");
    // Enable and disable emit the SAME invalidation — the tag names the
    // resource, not the new value.
    expectPluginsListBroadcast();
  });

  test("threads x-vellum-client-id into the published event's originClientId", () => {
    disablePluginSpy.mockImplementation((name) =>
      toggleResult(name, "disable"),
    );

    invokeDisable({
      pathParams: { name: "simple-memory" },
      headers: { "x-vellum-client-id": "client-xyz" },
    });

    const [msg] = broadcastMessageSpy.mock.calls[0]!;
    expect(msg).toMatchObject({
      type: "sync_changed",
      originClientId: "client-xyz",
    });
  });

  test("PluginAlreadyInStateException → ConflictError (409), no broadcast", () => {
    disablePluginSpy.mockImplementation((name) => {
      throw new PluginAlreadyInStateException(name, "disable");
    });

    expect(() =>
      invokeDisable({ pathParams: { name: "simple-memory" } }),
    ).toThrow(ConflictError);
    expect(broadcastMessageSpy).not.toHaveBeenCalled();
  });

  test("PluginDirectoryNotFoundError → NotFoundError (404)", () => {
    disablePluginSpy.mockImplementation((name) => {
      throw new PluginDirectoryNotFoundError(name);
    });

    expect(() => invokeDisable({ pathParams: { name: "ghost" } })).toThrow(
      NotFoundError,
    );
  });

  test("InvalidPluginNameError → BadRequestError (400)", () => {
    disablePluginSpy.mockImplementation(() => {
      throw new ToggleInvalidPluginNameError("../escape");
    });

    expect(() => invokeDisable({ pathParams: { name: "../escape" } })).toThrow(
      BadRequestError,
    );
  });
});

// ---------------------------------------------------------------------------
// GET /v1/plugins/:name/icon
// ---------------------------------------------------------------------------

const ICON_PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Minimal valid PNG: signature + IHDR width/height, within the 128×128 cap. */
function makeIconPng(width = 64, height = 64): Buffer {
  const buf = Buffer.alloc(24);
  ICON_PNG_SIGNATURE.copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii"); // IHDR chunk type
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * Create `<workspacePlugins>/<name>/`, optionally writing `icon.png` into it.
 * Returns the plugin directory so the caller can clean it up. Uses the real
 * `getWorkspacePluginsDir()` (rooted at the per-test temp workspace), so the
 * route's real `readValidatedPluginIcon` + `readFileSync` path is exercised.
 */
function makePluginDir(name: string, icon?: Buffer): string {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  if (icon) {
    writeFileSync(join(dir, "icon.png"), icon);
  }
  return dir;
}

describe("GET /v1/plugins/:name/icon", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serves the validated icon.png as image/png with caching headers", () => {
    const bytes = makeIconPng(64, 64);
    created.push(makePluginDir("with-icon", bytes));

    const result = iconHandler({
      pathParams: { name: "with-icon" },
    }) as RouteResponse;

    // Exact bytes flow through unmodified as an image/png body.
    expect(result).toBeInstanceOf(RouteResponse);
    expect(Buffer.from(result.body as Uint8Array).equals(bytes)).toBe(true);
    expect(result.headers["Content-Type"]).toBe("image/png");
    expect(result.headers["Content-Length"]).toBe(String(bytes.length));
    // Private immutable cache + nosniff: an authenticated per-workspace
    // resource, content-addressed by the ETag; no shared cache may reuse it.
    expect(result.headers["Cache-Control"]).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(result.headers["X-Content-Type-Options"]).toBe("nosniff");
    // ETag is the quoted content-hash iconVersion (16 hex chars).
    expect(result.headers.ETag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("404 (NotFoundError) when the installed plugin ships no valid icon", () => {
    // Directory exists but carries no icon.png → validator returns hasIcon:false.
    created.push(makePluginDir("no-icon"));

    expect(() => iconHandler({ pathParams: { name: "no-icon" } })).toThrow(
      NotFoundError,
    );
  });

  test("400 (BadRequestError) on a traversal / malformed name", () => {
    // The name guard rejects `../escape` before it can become a filesystem
    // path, so no icon is ever read for an out-of-tree name.
    expect(() => iconHandler({ pathParams: { name: "../escape" } })).toThrow(
      BadRequestError,
    );
  });
});
