/**
 * Tests for the plugins route handlers in `plugins-routes.ts`.
 *
 * Covers:
 *   - Projection from `InstalledPluginInfo` → response shape (id, name,
 *     description, version, path; issues omitted when empty)
 *   - `?q=` substring filter (case-insensitive across id/name/description)
 *   - Trimming + empty-string fallthrough on `?q=`
 *   - Empty install dir → `{ plugins: [] }`
 *   - Issues array surfaced when present
 *
 * The library function itself is covered by
 * `assistant/src/cli/lib/__tests__/list-installed-plugins.test.ts`; here
 * we mock it to isolate the route's projection + filter logic.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { InstalledPluginInfo } from "../../../cli/lib/list-installed-plugins.js";

// Mutable list returned by the mocked library function. Tests reassign
// `installedFixture` before invoking the handler.
let installedFixture: InstalledPluginInfo[] = [];

mock.module("../../../cli/lib/list-installed-plugins.js", () => ({
  listInstalledPlugins: () => installedFixture,
}));

import { ROUTES as PLUGINS_ROUTES } from "../plugins-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = PLUGINS_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const listHandler = findHandler("plugins_list");

function invoke(
  args: RouteHandlerArgs = {},
): { plugins: Array<Record<string, unknown>> } {
  return listHandler(args) as { plugins: Array<Record<string, unknown>> };
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
