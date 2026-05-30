/**
 * Tests for `assistant/src/memory/v3/selection-log-store.ts`.
 *
 * Asserts the inspector read path over `memory_v3_selections`:
 *   - null when the conversation has no v3 rows;
 *   - latest-turn selection when no preferred turn is given;
 *   - the preferred turn's rows when it has them;
 *   - fallback to the latest turn when the preferred turn has no rows;
 *   - source/pinned mapping and the rendered `<memory>` block;
 *   - `live` / `shadow` reflect the flag resolver.
 *
 * `mock.module` is process-global and leaks into sibling files in a
 * `bun test src/memory/v3/` run, so every stub DELEGATES to the real
 * implementation unless this test is actively running (`storeMockActive`,
 * toggled in beforeEach/afterAll). Mirrors `shadow-plugin.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../migrations/268-add-memory-v3-selections.js";
import * as schema from "../../schema.js";

const realFlags = {
  ...(await import("../../../config/assistant-feature-flags.js")),
};
const realLoader = { ...(await import("../../../config/loader.js")) };
const realDb = { ...(await import("../../db-connection.js")) };
const realPageContent = { ...(await import("../page-content.js")) };

let storeMockActive = false;
let liveEnabled = false;
let shadowEnabled = false;

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  return db;
}

function seed(
  conversationId: string,
  turn: number,
  rows: Array<{ slug: string; source: string; pinned?: boolean }>,
): void {
  const stmt = testSqlite.query(
    `INSERT INTO memory_v3_selections (conversation_id, turn, slug, source, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      conversationId,
      turn,
      r.slug,
      r.source,
      r.pinned ? 1 : 0,
      1000 + turn,
    );
  }
}

mock.module("../../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (key: string, config: unknown) =>
    storeMockActive
      ? key === "memory-v3-live"
        ? liveEnabled
        : key === "memory-v3-shadow"
          ? shadowEnabled
          : false
      : realFlags.isAssistantFeatureFlagEnabled(
          key as Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[0],
          config as Parameters<
            typeof realFlags.isAssistantFeatureFlagEnabled
          >[1],
        ),
}));

mock.module("../../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => (storeMockActive ? {} : realLoader.getConfig()),
}));

mock.module("../../db-connection.js", () => ({
  ...realDb,
  getDb: () => (storeMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    storeMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
}));

mock.module("../page-content.js", () => ({
  ...realPageContent,
  renderV3PageContent: async (slug: string) =>
    storeMockActive
      ? `body for ${slug}`
      : realPageContent.renderV3PageContent(slug),
}));

const { getMemoryV3SelectionForInspector } =
  await import("../selection-log-store.js");

beforeEach(() => {
  storeMockActive = true;
  liveEnabled = false;
  shadowEnabled = false;
  testDb = makeDb();
});

afterAll(() => {
  storeMockActive = false;
});

describe("getMemoryV3SelectionForInspector", () => {
  test("returns null when the conversation has no v3 selections", async () => {
    expect(await getMemoryV3SelectionForInspector("conv-empty")).toBeNull();
  });

  test("returns the latest turn's selection when no preferred turn is given", async () => {
    seed("conv-1", 1, [{ slug: "domain-a/page-1", source: "l1+l2" }]);
    seed("conv-1", 3, [
      { slug: "domain-a/page-2", source: "core+l2", pinned: true },
      { slug: "domain-b/page-3", source: "carry-forward" },
    ]);

    const log = await getMemoryV3SelectionForInspector("conv-1");
    expect(log?.turn).toBe(3);
    expect(log?.selections.map((s) => s.slug)).toEqual([
      "domain-a/page-2",
      "domain-b/page-3",
    ]);
  });

  test("uses the preferred turn when it has rows", async () => {
    seed("conv-2", 2, [{ slug: "domain-a/page-1", source: "l1+l2" }]);
    seed("conv-2", 7, [{ slug: "domain-b/page-9", source: "l1+l2" }]);

    const log = await getMemoryV3SelectionForInspector("conv-2", 2);
    expect(log?.turn).toBe(2);
    expect(log?.selections.map((s) => s.slug)).toEqual(["domain-a/page-1"]);
  });

  test("falls back to the latest turn when the preferred turn has no rows", async () => {
    seed("conv-3", 5, [{ slug: "domain-a/page-1", source: "l1+l2" }]);

    const log = await getMemoryV3SelectionForInspector("conv-3", 99);
    expect(log?.turn).toBe(5);
    expect(log?.selections).toHaveLength(1);
  });

  test("maps source/pinned and renders the <memory> block", async () => {
    seed("conv-4", 1, [
      { slug: "domain-a/page-1", source: "core+l2", pinned: true },
      { slug: "domain-b/page-2", source: "carry-forward", pinned: false },
    ]);

    const log = await getMemoryV3SelectionForInspector("conv-4");
    expect(log?.selections).toEqual([
      { slug: "domain-a/page-1", source: "core+l2", pinned: true },
      { slug: "domain-b/page-2", source: "carry-forward", pinned: false },
    ]);
    expect(log?.injectedText).toContain("<memory>");
    expect(log?.injectedText).toContain("body for domain-a/page-1");
    expect(log?.injectedText).toContain("body for domain-b/page-2");
  });

  test("live/shadow reflect the flag resolver", async () => {
    seed("conv-5", 1, [{ slug: "domain-a/page-1", source: "l1+l2" }]);

    const off = await getMemoryV3SelectionForInspector("conv-5");
    expect(off?.live).toBe(false);
    expect(off?.shadow).toBe(false);

    liveEnabled = true;
    shadowEnabled = true;
    const on = await getMemoryV3SelectionForInspector("conv-5");
    expect(on?.live).toBe(true);
    expect(on?.shadow).toBe(true);
  });
});
