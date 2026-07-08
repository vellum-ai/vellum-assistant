/**
 * Tests for `ever-injected-store.ts` — memory-v3's per-conversation
 * everInjected record:
 *   - record/get/active-set round-trip and re-record clearing `pruned_at`;
 *   - `markPruned` excluding rows from the active set and `residentBytes`;
 *   - `clearConversation` (compaction reset);
 *   - fork hooks: full-row copy (pruned state included) and truncated-fork
 *     seeding (`bytes = 0`, dedup-only);
 *   - migration idempotence (run twice).
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the db-connection stub DELEGATES to the real implementation unless
 * this test is actively running (`storeMockActive`, toggled in
 * beforeEach/afterAll). Mirrors `__tests__/selection-log-store.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3EverInjected } from "../../../../persistence/migrations/277-add-memory-v3-ever-injected.js";
import * as schema from "../../../../persistence/schema/index.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};

let storeMockActive = false;

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3EverInjected(db);
  return db;
}

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getDb: () => (storeMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    storeMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
}));

const {
  clearConversation,
  forkEverInjected,
  getActiveSlugs,
  getInjected,
  getPrunedSlugs,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  recordInjected,
  residentBytes,
  seedEverInjectedFromSlugs,
} = await import("./ever-injected-store.js");

beforeEach(() => {
  storeMockActive = true;
  testDb = makeDb();
});

afterAll(() => {
  storeMockActive = false;
});

describe("metadata key constant", () => {
  test("exports the v3 injected-block metadata key", () => {
    expect(MEMORY_V3_INJECTED_BLOCK_METADATA_KEY).toBe("memoryV3InjectedBlock");
  });
});

describe("recordInjected / getInjected / getActiveSlugs", () => {
  test("round-trips the recorded entries", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", bytes: 100 },
        { slug: "topics/page-b", bytes: 250 },
      ],
      1_000,
    );

    expect(getInjected("conv-1")).toEqual(
      new Map([
        ["topics/page-a", { bytes: 100, prunedAt: null }],
        ["topics/page-b", { bytes: 250, prunedAt: null }],
      ]),
    );
    expect(getActiveSlugs("conv-1")).toEqual(
      new Set(["topics/page-a", "topics/page-b"]),
    );
    // Other conversations see nothing.
    expect(getInjected("conv-other").size).toBe(0);
    expect(getActiveSlugs("conv-other").size).toBe(0);
  });

  test("re-recording a pruned slug clears pruned_at and refreshes bytes", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 100,
      prunedAt: 2_000,
    });

    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 140 }], 3_000);

    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: null,
    });
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    const row = testSqlite
      .query(
        "SELECT injected_at FROM memory_v3_ever_injected WHERE conversation_id = ? AND slug = ?",
      )
      .get("conv-1", "topics/page-a") as { injected_at: number };
    expect(row.injected_at).toBe(3_000);
  });

  test("empty entries are a no-op", () => {
    recordInjected("conv-1", []);
    expect(getInjected("conv-1").size).toBe(0);
  });
});

describe("markPruned / residentBytes", () => {
  test("pruned rows leave the active set and resident bytes but stay on record", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", bytes: 100 },
        { slug: "topics/page-b", bytes: 250 },
        { slug: "topics/page-c", bytes: 50 },
      ],
      1_000,
    );
    expect(residentBytes("conv-1")).toBe(400);

    markPruned("conv-1", ["topics/page-a", "topics/page-c"], 2_000);

    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-b"]));
    expect(residentBytes("conv-1")).toBe(250);
    // Rows are never deleted — the record stays auditable.
    expect([...getInjected("conv-1").keys()].sort()).toEqual([
      "topics/page-a",
      "topics/page-b",
      "topics/page-c",
    ]);
  });

  test("empty slug list is a no-op and residentBytes is 0 for unknown conversations", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", [], 2_000);
    expect(residentBytes("conv-1")).toBe(100);
    expect(residentBytes("conv-unknown")).toBe(0);
  });
});

describe("clearConversation", () => {
  test("deletes all rows for the conversation only", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    recordInjected("conv-2", [{ slug: "topics/page-b", bytes: 200 }], 1_000);

    clearConversation("conv-1");

    expect(getInjected("conv-1").size).toBe(0);
    expect(getInjected("conv-2").size).toBe(1);
  });
});

describe("forkEverInjected", () => {
  test("copies the parent's full record, pruned state included", () => {
    recordInjected(
      "conv-parent",
      [
        { slug: "topics/page-a", bytes: 100 },
        { slug: "topics/page-b", bytes: 250 },
      ],
      1_000,
    );
    markPruned("conv-parent", ["topics/page-b"], 2_000);

    forkEverInjected(testDb, "conv-parent", "conv-child");

    expect(getInjected("conv-child")).toEqual(
      new Map([
        ["topics/page-a", { bytes: 100, prunedAt: null }],
        ["topics/page-b", { bytes: 250, prunedAt: 2_000 }],
      ]),
    );
    expect(residentBytes("conv-child")).toBe(100);
    // Parent record is untouched.
    expect(getInjected("conv-parent").size).toBe(2);
  });

  test("is a no-op when the parent has no rows", () => {
    forkEverInjected(testDb, "conv-empty", "conv-child");
    expect(getInjected("conv-child").size).toBe(0);
  });
});

describe("seedEverInjectedFromSlugs", () => {
  test("seeds dedup-only rows with bytes = 0 stamped at the given time", () => {
    seedEverInjectedFromSlugs(
      testDb,
      "conv-parent",
      "conv-child",
      ["topics/page-a", "topics/page-b"],
      5_000,
    );

    expect(getInjected("conv-child")).toEqual(
      new Map([
        ["topics/page-a", { bytes: 0, prunedAt: null }],
        ["topics/page-b", { bytes: 0, prunedAt: null }],
      ]),
    );
    expect(getActiveSlugs("conv-child")).toEqual(
      new Set(["topics/page-a", "topics/page-b"]),
    );
    // Inherited cards carry no byte accounting — resident accounting
    // restarts from the fork's own injections.
    expect(residentBytes("conv-child")).toBe(0);
    const row = testSqlite
      .query(
        "SELECT injected_at FROM memory_v3_ever_injected WHERE conversation_id = ? AND slug = ?",
      )
      .get("conv-child", "topics/page-a") as { injected_at: number };
    expect(row.injected_at).toBe(5_000);
  });

  test("carries the parent's pruned_at tombstones for inherited slugs", () => {
    // Parent injected both pages, then pruned page-a: the metadata block the
    // child inherits still contains page-a's section, so the fork scan seeds
    // both slugs — but page-a must arrive tombstoned, not active, or the
    // child's rehydration would resurrect a card the parent's live view lost.
    recordInjected(
      "conv-parent",
      [
        { slug: "topics/page-a", bytes: 100 },
        { slug: "topics/page-b", bytes: 200 },
      ],
      1_000,
    );
    markPruned("conv-parent", ["topics/page-a"], 2_000);

    seedEverInjectedFromSlugs(
      testDb,
      "conv-parent",
      "conv-child",
      ["topics/page-a", "topics/page-b"],
      5_000,
    );

    expect(getInjected("conv-child")).toEqual(
      new Map([
        ["topics/page-a", { bytes: 0, prunedAt: 2_000 }],
        ["topics/page-b", { bytes: 0, prunedAt: null }],
      ]),
    );
    expect(getActiveSlugs("conv-child")).toEqual(new Set(["topics/page-b"]));
    expect(getPrunedSlugs("conv-child")).toEqual(new Set(["topics/page-a"]));

    // Re-selection clears the inherited tombstone, same as in the parent.
    recordInjected("conv-child", [{ slug: "topics/page-a", bytes: 50 }], 6_000);
    expect(getActiveSlugs("conv-child")).toEqual(
      new Set(["topics/page-a", "topics/page-b"]),
    );
  });

  test("is a no-op for an empty slug list and never overwrites existing rows", () => {
    seedEverInjectedFromSlugs(testDb, "conv-parent", "conv-child", [], 5_000);
    expect(getInjected("conv-child").size).toBe(0);

    recordInjected(
      "conv-child",
      [{ slug: "topics/page-a", bytes: 100 }],
      1_000,
    );
    seedEverInjectedFromSlugs(
      testDb,
      "conv-parent",
      "conv-child",
      ["topics/page-a"],
      5_000,
    );
    expect(getInjected("conv-child").get("topics/page-a")).toEqual({
      bytes: 100,
      prunedAt: null,
    });
  });
});

describe("migration", () => {
  test("is idempotent — running twice leaves a usable table", () => {
    // makeDb() already ran the migration once; run it again.
    migrateAddMemoryV3EverInjected(testDb);

    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
  });
});
