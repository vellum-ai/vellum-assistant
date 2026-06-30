import { describe, expect, test } from "bun:test";

import type {
  InstalledPlugin,
  PluginCatalogMatch,
  PluginListItem,
} from "./types";
import {
  filterByStatus,
  matchesQuery,
  mergePlugins,
  shortSha,
  sortPlugins,
} from "./utils";

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "alpha",
    name: "alpha",
    description: null,
    version: null,
    ...overrides,
  };
}

function catalog(overrides: Partial<PluginCatalogMatch> = {}): PluginCatalogMatch {
  return {
    name: "beta",
    path: "github:acme/beta@main",
    category: null,
    source: { kind: "github", repo: "acme/beta", ref: "main" },
    ...overrides,
  };
}

function item(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return {
    name: "x",
    status: "available",
    external: true,
    ...overrides,
  };
}

describe("mergePlugins", () => {
  test("maps installed and catalog into one list with status/external", () => {
    const result = mergePlugins(
      [installed({ name: "alpha", description: "A", version: "1.0.0" })],
      [catalog({ name: "beta", description: "B" })],
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: "alpha",
      description: "A",
      status: "installed",
      version: "1.0.0",
    });
    // Installed origin is unknown (the list endpoint has no `source`).
    expect(result[0].external).toBeUndefined();
    expect(result[1]).toMatchObject({
      name: "beta",
      description: "B",
      status: "available",
      external: true,
    });
  });

  test("drops catalog entries already installed (dedup by name)", () => {
    const result = mergePlugins(
      [installed({ name: "dup" })],
      [catalog({ name: "dup" }), catalog({ name: "fresh" })],
    );

    expect(result.map((p) => p.name)).toEqual(["dup", "fresh"]);
    expect(result.find((p) => p.name === "dup")?.status).toBe("installed");
  });

  test("normalizes null description/version to undefined", () => {
    const [row] = mergePlugins(
      [installed({ name: "alpha", description: null, version: null })],
      [],
    );

    expect(row.description).toBeUndefined();
    expect(row.version).toBeUndefined();
  });
});

describe("matchesQuery", () => {
  test("empty query matches everything", () => {
    expect(matchesQuery(item({ name: "anything" }), "")).toBe(true);
    expect(matchesQuery(item({ name: "anything" }), "   ")).toBe(true);
  });

  test("matches against name (case-insensitive)", () => {
    expect(matchesQuery(item({ name: "GitHub" }), "hub")).toBe(true);
  });

  test("matches against description (case-insensitive)", () => {
    expect(
      matchesQuery(item({ name: "x", description: "Linear tickets" }), "linear"),
    ).toBe(true);
  });

  test("returns false when neither name nor description matches", () => {
    expect(
      matchesQuery(item({ name: "x", description: "nope" }), "zzz"),
    ).toBe(false);
  });
});

describe("sortPlugins", () => {
  test("installed first, then alphabetical by name", () => {
    const items = [
      item({ name: "zeta", status: "available" }),
      item({ name: "beta", status: "installed" }),
      item({ name: "alpha", status: "available" }),
      item({ name: "gamma", status: "installed" }),
    ];

    expect(sortPlugins(items).map((p) => p.name)).toEqual([
      "beta",
      "gamma",
      "alpha",
      "zeta",
    ]);
  });

  test("does not mutate the input array", () => {
    const items = [item({ name: "b" }), item({ name: "a" })];
    const before = items.map((p) => p.name);
    sortPlugins(items);
    expect(items.map((p) => p.name)).toEqual(before);
  });
});

describe("filterByStatus", () => {
  const items = [
    item({ name: "a", status: "installed" }),
    item({ name: "b", status: "available" }),
    item({ name: "c", status: "installed" }),
  ];

  test("all returns everything", () => {
    expect(filterByStatus(items, "all")).toHaveLength(3);
  });

  test("installed returns only installed", () => {
    expect(filterByStatus(items, "installed").map((p) => p.name)).toEqual([
      "a",
      "c",
    ]);
  });

  test("available returns only available", () => {
    expect(filterByStatus(items, "available").map((p) => p.name)).toEqual(["b"]);
  });
});

describe("shortSha", () => {
  test("truncates a commit SHA to its first 7 chars", () => {
    expect(shortSha("1234567890abcdef1234567890abcdef12345678")).toBe("1234567");
  });

  test("returns 'unknown' for a null SHA", () => {
    expect(shortSha(null)).toBe("unknown");
  });
});
