/**
 * Regression tests for catalog entry normalization in catalog-install.ts.
 *
 * The platform `/v1/skills/` API flattens skill metadata into top-level
 * fields (`category`, `display_name`, `icon`) rather than the nested
 * `metadata.vellum.*` shape used by the local `catalog.json`. Both
 * `fetchCatalog` (remote) and `readLocalCatalog` (local file) must produce a
 * canonical `CatalogSkill` whose `metadata.vellum.category` is populated, so
 * downstream category assignment doesn't fall back to "system" for every skill.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => "https://platform.example.com",
}));

import { fetchCatalog, readLocalCatalog } from "../skills/catalog-install.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchCatalog normalization", () => {
  test("re-nests the platform's flattened category under metadata.vellum", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          skills: [
            {
              id: "amazon",
              name: "amazon",
              display_name: "Amazon",
              description: "Shop on Amazon",
              icon: "🛒",
              category: "commerce",
              updated_at: "2026-04-19T19:26:17Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const catalog = await fetchCatalog();

    expect(catalog).toHaveLength(1);
    const [skill] = catalog;
    expect(skill.id).toBe("amazon");
    expect(skill.metadata?.vellum?.category).toBe("commerce");
    expect(skill.metadata?.vellum?.["display-name"]).toBe("Amazon");
    expect(skill.icon).toBe("🛒");
    expect(skill.metadata?.icon).toBe("🛒");
    expect(skill.updatedAt).toBe("2026-04-19T19:26:17Z");
  });

  test("leaves category undefined when the API omits it", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          skills: [{ id: "no-cat", name: "no-cat", description: "d" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const catalog = await fetchCatalog();

    expect(catalog).toHaveLength(1);
    expect(catalog[0].metadata?.vellum?.category).toBeUndefined();
  });

  test("drops entries without a string id", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          skills: [{ name: "missing-id", description: "d" }, { id: 42 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const catalog = await fetchCatalog();

    expect(catalog).toHaveLength(0);
  });
});

describe("readLocalCatalog normalization", () => {
  test("reads the nested metadata.vellum.category from catalog.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-catalog-"));
    try {
      writeFileSync(
        join(dir, "catalog.json"),
        JSON.stringify({
          version: 1,
          skills: [
            {
              id: "tasks",
              name: "tasks",
              description: "Task management",
              metadata: {
                icon: "✅",
                vellum: { "display-name": "Tasks", category: "productivity" },
              },
            },
          ],
        }),
      );

      const catalog = readLocalCatalog(dir);

      expect(catalog).toHaveLength(1);
      expect(catalog[0].metadata?.vellum?.category).toBe("productivity");
      expect(catalog[0].metadata?.vellum?.["display-name"]).toBe("Tasks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
