/**
 * Tests for `usePluginsList`, the shared data hook backing the Plugins tab
 * list. It owns the installed read (`pluginsGet`, with an older-daemon
 * 404 → empty degradation) and the catalog read (`pluginsSearchGet`), merged
 * and sorted into one `PluginListItem[]`.
 *
 * The generated SDK layer is mocked so both reads resolve locally. Per-test
 * fixtures are assigned to module-level holders the mocks read, letting each
 * case drive the installed/catalog payloads (or force a catalog failure).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";

type InstalledPlugin = PluginsGetResponse["plugins"][number];
type CatalogMatch = PluginsSearchGetResponse["matches"][number];

interface InstalledResult {
  data?: PluginsGetResponse;
  response: { ok: boolean; status: number };
}

// Per-test holders the SDK mocks read. `catalogResult` may be an Error to
// drive the catalog query into its failure (degrade-to-installed) branch.
let installedResult: InstalledResult;
let catalogResult: PluginsSearchGetResponse | Error;
// When set, the catalog mock awaits this gate before resolving — lets a test
// hold the catalog query pending while the installed query resolves.
let catalogGate: Promise<unknown> | null = null;
// When set, the installed mock awaits this gate before resolving — lets a test
// hold a category-filtered installed read pending after the initial load.
let installedGate: Promise<unknown> | null = null;

const sdkActual = await import("@/generated/daemon/sdk.gen");
// Mirrors the daemon: an unfiltered read returns `installedResult` as-is; a
// `?category=` read narrows the installed plugins to that category server-side.
const pluginsGetSpy = mock(
  async (options: { query?: { category?: string } }) => {
    if (installedGate) await installedGate;
    const selected = options?.query?.category;
    if (!selected) return installedResult;
    const plugins = (installedResult.data?.plugins ?? []).filter(
      (p) => (p.category ?? "system") === selected,
    );
    return { ...installedResult, data: { ...installedResult.data, plugins } };
  },
);
const pluginsSearchGetSpy = mock(async () => {
  if (catalogGate) await catalogGate;
  if (catalogResult instanceof Error) throw catalogResult;
  return { data: catalogResult };
});
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsGet: pluginsGetSpy,
  pluginsSearchGet: pluginsSearchGetSpy,
}));

const { usePluginsList } = await import(
  "@/domains/intelligence/plugins/use-plugins-list"
);

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  // `enabled` is omitted by default to model an older daemon that predates the
  // enable/disable surface; tests opt in via `installed({ enabled })`. The cast
  // is needed because the generated element type marks `enabled` as required.
  return {
    id: "alpha",
    name: "alpha",
    description: null,
    version: null,
    ...overrides,
  } as InstalledPlugin;
}

function match(overrides: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    name: "beta",
    path: "github:acme/beta@main",
    category: null,
    source: { kind: "github", repo: "acme/beta", ref: "main" },
    ...overrides,
  };
}

function installedOk(plugins: InstalledPlugin[]): InstalledResult {
  return { data: { plugins }, response: { ok: true, status: 200 } };
}

function catalogOk(matches: CatalogMatch[]): PluginsSearchGetResponse {
  return { query: "", ref: "main", matches };
}

function renderPluginsList(category: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return renderHook(() => usePluginsList(ASSISTANT_ID, category), { wrapper });
}

beforeEach(() => {
  installedResult = installedOk([]);
  catalogResult = catalogOk([]);
  catalogGate = null;
  installedGate = null;
  pluginsGetSpy.mockClear();
  pluginsSearchGetSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("usePluginsList", () => {
  test("merges installed + catalog into one sorted list", async () => {
    installedResult = installedOk([
      installed({ id: "delta", name: "delta", description: "D" }),
      installed({ id: "bravo", name: "bravo" }),
    ]);
    catalogResult = catalogOk([
      match({ name: "echo", description: "E" }),
      match({ name: "alpha", description: "A" }),
    ]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.items).toHaveLength(4));

    // Installed first (alphabetical), then available (alphabetical).
    expect(result.current.items.map((p) => p.name)).toEqual([
      "bravo",
      "delta",
      "alpha",
      "echo",
    ]);
    expect(result.current.items.map((p) => p.status)).toEqual([
      "installed",
      "installed",
      "available",
      "available",
    ]);
    expect(result.current.isError).toBe(false);
    expect(result.current.catalogError).toBe(false);
  });

  test("dedups catalog entries already installed (by name)", async () => {
    installedResult = installedOk([installed({ id: "dup", name: "dup" })]);
    catalogResult = catalogOk([match({ name: "dup" }), match({ name: "fresh" })]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    expect(result.current.items.map((p) => p.name)).toEqual(["dup", "fresh"]);
    expect(result.current.items.find((p) => p.name === "dup")?.status).toBe(
      "installed",
    );
  });

  test("dedups catalog rows against installed in another category (unfiltered)", async () => {
    // `dup` is installed under category "a", but its catalog entry is "b".
    installedResult = installedOk([
      installed({ id: "dup", name: "dup", category: "a" }),
    ]);
    catalogResult = catalogOk([
      match({ name: "dup", category: "b" }),
      match({ name: "fresh", category: "b" }),
    ]);

    // Selecting "b": the installed read is server-filtered to "b" (empty, since
    // `dup` is in "a"), yet `dup` must still be deduped against the UNFILTERED
    // installed set and never appear as Available.
    const { result } = renderPluginsList("b");

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items.map((p) => p.name)).toEqual(["fresh"]);
    expect(result.current.items[0]?.status).toBe("available");
    expect(result.current.unfilteredInstalledNames.has("dup")).toBe(true);
  });

  test("installed 404 degrades to an empty installed list, not an error", async () => {
    installedResult = { data: undefined, response: { ok: false, status: 404 } };
    catalogResult = catalogOk([match({ name: "alpha" })]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Only the catalog entry survives; installed is empty, not errored.
    expect(result.current.items.map((p) => p.name)).toEqual(["alpha"]);
    expect(result.current.items[0]?.status).toBe("available");
    expect(result.current.isError).toBe(false);
    expect(result.current.catalogError).toBe(false);
  });

  test("installed plugins render while the catalog is still loading", async () => {
    let releaseCatalog: () => void = () => {};
    catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    installedResult = installedOk([installed({ id: "alpha", name: "alpha" })]);
    catalogResult = catalogOk([match({ name: "beta" })]);

    const { result } = renderPluginsList();

    // Installed resolves first: the list is no longer "loading" and shows the
    // installed plugin even though the catalog query is still pending.
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.catalogLoading).toBe(true);
    expect(result.current.items[0]?.name).toBe("alpha");

    // Once the catalog resolves, the available entry joins the list.
    releaseCatalog();
    await waitFor(() => expect(result.current.catalogLoading).toBe(false));
    expect(result.current.items.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  test("non-404 installed failure is fatal (isError)", async () => {
    installedResult = { data: undefined, response: { ok: false, status: 500 } };
    catalogResult = catalogOk([match({ name: "alpha" })]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("catalog failure degrades to installed-only via catalogError", async () => {
    installedResult = installedOk([installed({ id: "alpha", name: "alpha" })]);
    catalogResult = new Error("catalog down");

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.catalogError).toBe(true));

    // Installed list still renders; the catalog failure is not fatal.
    expect(result.current.items.map((p) => p.name)).toEqual(["alpha"]);
    expect(result.current.isError).toBe(false);
  });

  test("category support stays true while a category-filtered read is pending", async () => {
    // The initial unfiltered load is taxonomy-aware (carries categoryCounts),
    // so support latches true.
    installedResult = {
      data: {
        plugins: [installed({ category: "email" })],
        categoryCounts: { email: 1 },
        totalCount: 1,
      } as PluginsGetResponse,
      response: { ok: true, status: 200 },
    };

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }
    const { result, rerender } = renderHook(
      ({ category }: { category: string | null }) =>
        usePluginsList(ASSISTANT_ID, category),
      { wrapper, initialProps: { category: null as string | null } },
    );

    await waitFor(() => expect(result.current.categorySupported).toBe(true));

    // Hold every subsequent installed read pending, then select a category. The
    // filtered main read is now in flight (as is any uncached unfiltered
    // re-read), so the unfiltered source is momentarily undefined — yet support
    // must NOT regress to false, which would collapse the category rail.
    let releaseInstalled: () => void = () => {};
    installedGate = new Promise<void>((resolve) => {
      releaseInstalled = resolve;
    });
    rerender({ category: "email" });

    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.categorySupported).toBe(true);

    // It stays true once the filtered read finally resolves, too.
    releaseInstalled();
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.categorySupported).toBe(true);
  });

  test("category support resets when the active assistant changes", async () => {
    // Assistant A's daemon is taxonomy-aware, so support latches true.
    installedResult = {
      data: {
        plugins: [installed({ category: "email" })],
        categoryCounts: { email: 1 },
        totalCount: 1,
      } as PluginsGetResponse,
      response: { ok: true, status: 200 },
    };

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }
    const { result, rerender } = renderHook(
      ({ assistantId }: { assistantId: string }) =>
        usePluginsList(assistantId, null),
      { wrapper, initialProps: { assistantId: "asst-a" } },
    );

    await waitFor(() => expect(result.current.categorySupported).toBe(true));

    // Switching to an assistant whose daemon omits categoryCounts must drop the
    // sticky latch — otherwise the rail would render (and `?category=` would be
    // sent) for an assistant that does not support the category surface.
    installedResult = {
      data: { plugins: [installed()] } as PluginsGetResponse,
      response: { ok: true, status: 200 },
    };
    rerender({ assistantId: "asst-b" });

    await waitFor(() =>
      expect(result.current.categorySupported).toBe(false),
    );
  });

  test("exposes enabled on installed items and latches pluginToggleSupported", async () => {
    installedResult = installedOk([
      installed({ id: "alpha", name: "alpha", enabled: true }),
      installed({ id: "bravo", name: "bravo", enabled: false }),
    ]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    // Installed rows carry the daemon's enablement (alphabetical: alpha, bravo).
    expect(result.current.items.map((p) => p.enabled)).toEqual([true, false]);
    expect(result.current.pluginToggleSupported).toBe(true);
  });

  test("pluginToggleSupported stays false when the daemon omits enabled", async () => {
    // Older daemon: installed items carry no `enabled` field.
    installedResult = installedOk([installed({ id: "alpha", name: "alpha" })]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]?.enabled).toBeUndefined();
    expect(result.current.pluginToggleSupported).toBe(false);
  });

  test("pluginToggleSupported resets when the active assistant changes", async () => {
    // Assistant A's daemon reports enablement, so support latches true.
    installedResult = installedOk([
      installed({ id: "alpha", name: "alpha", enabled: true }),
    ]);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }
    const { result, rerender } = renderHook(
      ({ assistantId }: { assistantId: string }) =>
        usePluginsList(assistantId, null),
      { wrapper, initialProps: { assistantId: "asst-a" } },
    );

    await waitFor(() =>
      expect(result.current.pluginToggleSupported).toBe(true),
    );

    // Switching to an assistant whose daemon omits `enabled` must drop the
    // sticky latch — otherwise the toggle would render for an assistant whose
    // daemon has no enable/disable surface.
    installedResult = installedOk([installed({ id: "beta", name: "beta" })]);
    rerender({ assistantId: "asst-b" });

    await waitFor(() =>
      expect(result.current.pluginToggleSupported).toBe(false),
    );
  });

  test("refetches unfiltered counts when the warmed catalog disagrees with the cached buckets", async () => {
    // Simulate a timeout-degraded first read: the daemon bucketed `mailer` under
    // `system` because the bounded category lookup timed out. The catalog (held
    // pending) actually knows `mailer` is `email`.
    const degraded: InstalledResult = {
      data: {
        plugins: [installed({ id: "mailer", name: "mailer", category: "system" })],
        categoryCounts: { system: 1 },
        totalCount: 1,
      } as PluginsGetResponse,
      response: { ok: true, status: 200 },
    };
    const warm: InstalledResult = {
      data: {
        plugins: [installed({ id: "mailer", name: "mailer", category: "email" })],
        categoryCounts: { email: 1 },
        totalCount: 1,
      } as PluginsGetResponse,
      response: { ok: true, status: 200 },
    };
    installedResult = degraded;
    catalogResult = catalogOk([match({ name: "mailer", category: "email" })]);
    let releaseCatalog: () => void = () => {};
    catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });

    const { result } = renderPluginsList();

    // Initial unfiltered read resolves degraded (catalog still pending).
    await waitFor(() =>
      expect(result.current.installedCategoryCounts).toEqual({ system: 1 }),
    );

    // The daemon catalog is now warm; a re-read returns the real category.
    installedResult = warm;
    releaseCatalog();

    // Catalog success exposes the disagreement, so the hook refetches the
    // unfiltered installed read and the badges heal to the real category.
    await waitFor(() =>
      expect(result.current.installedCategoryCounts).toEqual({ email: 1 }),
    );
    const unfilteredReads = pluginsGetSpy.mock.calls.filter(
      (c) => !c[0]?.query?.category,
    ).length;
    expect(unfilteredReads).toBeGreaterThanOrEqual(2);
  });
});
