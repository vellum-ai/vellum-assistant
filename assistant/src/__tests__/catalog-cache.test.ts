/**
 * Unit tests for the catalog cache (catalog-cache.ts).
 *
 * Validates TTL-based caching, re-fetch after expiry, stale-cache fallback
 * on fetch failure, and explicit cache invalidation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CatalogSkill } from "../skills/catalog-install.js";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

// Suppress logger output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockRepoSkillsDir: string | undefined = undefined;
let mockLocalCatalog: CatalogSkill[] = [];
let mockFetchCatalogResult: CatalogSkill[] = [];
let mockFetchCatalogError: Error | null = null;
let fetchCatalogCallCount = 0;
let readLocalCatalogCallCount = 0;

mock.module("../skills/catalog-install.js", () => ({
  getRepoSkillsDir: () => mockRepoSkillsDir,
  readLocalCatalog: (_dir: string) => {
    readLocalCatalogCallCount++;
    return mockLocalCatalog;
  },
  fetchCatalog: async () => {
    fetchCatalogCallCount++;
    if (mockFetchCatalogError) {
      throw mockFetchCatalogError;
    }
    return mockFetchCatalogResult;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getCatalog, invalidateCatalogCache } from "../skills/catalog-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleCatalog: CatalogSkill[] = [
  { id: "web-search", name: "Web Search", description: "Search the web" },
  { id: "browser", name: "Browser", description: "Browse the web" },
];

const updatedCatalog: CatalogSkill[] = [
  { id: "web-search", name: "Web Search v2", description: "Updated search" },
];

function resetState(): void {
  invalidateCatalogCache();
  mockRepoSkillsDir = undefined;
  mockLocalCatalog = [];
  mockFetchCatalogResult = [];
  mockFetchCatalogError = null;
  fetchCatalogCallCount = 0;
  readLocalCatalogCallCount = 0;
}

afterEach(resetState);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCatalog", () => {
  test("returns cached value within TTL without re-fetching", async () => {
    mockFetchCatalogResult = sampleCatalog;

    const first = await getCatalog();
    expect(first).toEqual(sampleCatalog);
    expect(fetchCatalogCallCount).toBe(1);

    // Second call should use cache
    const second = await getCatalog();
    expect(second).toEqual(sampleCatalog);
    expect(fetchCatalogCallCount).toBe(1); // no additional fetch
  });

  test("re-fetches after TTL expires", async () => {
    mockFetchCatalogResult = sampleCatalog;

    const first = await getCatalog();
    expect(first).toEqual(sampleCatalog);
    expect(fetchCatalogCallCount).toBe(1);

    // Simulate TTL expiry by manipulating Date.now
    const originalNow = Date.now;
    Date.now = () => originalNow() + 5 * 60 * 1000 + 1;

    try {
      mockFetchCatalogResult = updatedCatalog;
      const second = await getCatalog();
      expect(second).toEqual(updatedCatalog);
      expect(fetchCatalogCallCount).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("falls back to stale cache on fetch failure", async () => {
    mockFetchCatalogResult = sampleCatalog;

    // Populate cache
    const first = await getCatalog();
    expect(first).toEqual(sampleCatalog);

    // Expire cache and make fetch fail
    const originalNow = Date.now;
    Date.now = () => originalNow() + 5 * 60 * 1000 + 1;

    try {
      mockFetchCatalogError = new Error("Network timeout");
      const fallback = await getCatalog();
      expect(fallback).toEqual(sampleCatalog); // stale cache
    } finally {
      Date.now = originalNow;
    }
  });

  test("returns empty array on fetch failure with no stale cache", async () => {
    mockFetchCatalogError = new Error("Network timeout");

    const result = await getCatalog();
    expect(result).toEqual([]);
  });

  test("invalidateCatalogCache forces re-fetch", async () => {
    mockFetchCatalogResult = sampleCatalog;

    await getCatalog();
    expect(fetchCatalogCallCount).toBe(1);

    invalidateCatalogCache();

    mockFetchCatalogResult = updatedCatalog;
    const refreshed = await getCatalog();
    expect(refreshed).toEqual(updatedCatalog);
    expect(fetchCatalogCallCount).toBe(2);
  });

  test("merges local and remote catalogs when repoSkillsDir is set", async () => {
    mockRepoSkillsDir = "/mock/repo/skills";
    mockLocalCatalog = [
      { id: "web-search", name: "Local Web Search", description: "Local" },
    ];
    mockFetchCatalogResult = [
      { id: "web-search", name: "Remote Web Search", description: "Remote" },
      { id: "remote-only", name: "Remote Only", description: "Remote only" },
    ];

    const result = await getCatalog();
    expect(readLocalCatalogCallCount).toBe(1);
    expect(fetchCatalogCallCount).toBe(1); // still merges with remote
    // Local entry takes precedence for overlapping id
    expect(result).toEqual([
      { id: "web-search", name: "Local Web Search", description: "Local" },
      { id: "remote-only", name: "Remote Only", description: "Remote only" },
    ]);
  });

  test("falls back to local bundled catalog when remote fetch fails", async () => {
    mockRepoSkillsDir = "/mock/repo/skills";
    mockLocalCatalog = sampleCatalog;
    mockFetchCatalogError = new Error("Network timeout");

    const result = await getCatalog();
    expect(result).toEqual(sampleCatalog);
    expect(readLocalCatalogCallCount).toBe(1);
    expect(fetchCatalogCallCount).toBe(1); // attempted remote fetch
  });

  test("preserves merged cache when later remote fetch fails", async () => {
    mockRepoSkillsDir = "/mock/repo/skills";
    mockLocalCatalog = [
      { id: "web-search", name: "Local Web Search", description: "Local" },
    ];
    mockFetchCatalogResult = [
      { id: "web-search", name: "Remote Web Search", description: "Remote" },
      { id: "remote-only", name: "Remote Only", description: "Remote only" },
    ];

    // Prime the cache with a successful merged fetch.
    const merged = await getCatalog();
    expect(merged).toEqual([
      { id: "web-search", name: "Local Web Search", description: "Local" },
      { id: "remote-only", name: "Remote Only", description: "Remote only" },
    ]);

    // Expire TTL and make remote fetch fail.
    const originalNow = Date.now;
    Date.now = () => originalNow() + 5 * 60 * 1000 + 1;
    try {
      mockFetchCatalogError = new Error("Network timeout");
      const fallback = await getCatalog();
      // Must retain remote-only skills rather than regressing to bare local.
      expect(fallback).toEqual(merged);
    } finally {
      Date.now = originalNow;
    }
  });
});
