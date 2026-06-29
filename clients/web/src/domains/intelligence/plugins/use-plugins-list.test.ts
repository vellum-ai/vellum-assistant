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

const sdkActual = await import("@/generated/daemon/sdk.gen");
const pluginsGetSpy = mock(async () => installedResult);
const pluginsSearchGetSpy = mock(async () => {
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
  return {
    id: "alpha",
    name: "alpha",
    description: null,
    version: null,
    ...overrides,
  };
}

function match(overrides: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    name: "beta",
    path: "github:acme/beta@main",
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

function renderPluginsList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return renderHook(() => usePluginsList(ASSISTANT_ID), { wrapper });
}

beforeEach(() => {
  installedResult = installedOk([]);
  catalogResult = catalogOk([]);
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

    await waitFor(() => expect(result.current.isLoading).toBe(false));

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

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.items.map((p) => p.name)).toEqual(["dup", "fresh"]);
    expect(result.current.items.find((p) => p.name === "dup")?.status).toBe(
      "installed",
    );
  });

  test("installed 404 degrades to an empty installed list, not an error", async () => {
    installedResult = { data: undefined, response: { ok: false, status: 404 } };
    catalogResult = catalogOk([match({ name: "alpha" })]);

    const { result } = renderPluginsList();

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Only the catalog entry survives; installed is empty, not errored.
    expect(result.current.items.map((p) => p.name)).toEqual(["alpha"]);
    expect(result.current.items[0]?.status).toBe("available");
    expect(result.current.isError).toBe(false);
    expect(result.current.catalogError).toBe(false);
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
});
