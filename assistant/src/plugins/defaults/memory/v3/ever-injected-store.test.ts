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
 * The rows live on the dedicated memory connection, resolved via
 * `getMemorySqlite` — stubbed to an in-memory DB carrying the relocated table's
 * schema, with `memoryDbAvailable` toggled to `null` for the fail-soft case.
 * The fork functions still accept a main-DB handle (unused now) so their call
 * sites are unchanged.
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the db-connection stub DELEGATES to the real implementation unless
 * this test is actively running (`storeMockActive`, toggled in
 * beforeEach/afterAll). Mirrors `__tests__/selection-log-store.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { ensureMemoryV3EverInjectedSchema } from "../../../../persistence/migrations/345-move-memory-v3-ever-injected-to-memory-db.js";
import * as schema from "../../../../persistence/schema/index.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};

let storeMockActive = false;
let memoryDbAvailable = true;

// The fork functions still take a (now unused) main-DB handle; keep a drizzle
// stand-in to pass positionally so the call sites read the same as production.
let memorySqlite: Database;
makeDb();
function makeDb() {
  memorySqlite = new Database(":memory:");
  ensureMemoryV3EverInjectedSchema(memorySqlite);
}

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getMemorySqlite: () =>
    storeMockActive
      ? memoryDbAvailable
        ? memorySqlite
        : null
      : realDb.getMemorySqlite(),
  getMemoryDb: () =>
    storeMockActive
      ? memoryDbAvailable
        ? drizzle(memorySqlite, { schema })
        : null
      : realDb.getMemoryDb(),
}));

const {
  _resetEverInjectedRuntimeStateForTests,
  clearConversation,
  forkEverInjected,
  getActiveEntries,
  getActiveSlugs,
  getInjected,
  getPrunedSlugs,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  recordInjected,
  reconcilePersistedInjections,
  residentBytes,
  seedEverInjectedFromSlugs,
} = await import("./ever-injected-store.js");

beforeEach(() => {
  storeMockActive = true;
  memoryDbAvailable = true;
  makeDb();
  _resetEverInjectedRuntimeStateForTests();
  for (const conversationId of ["conv-1", "conv-parent", "conv-child"]) {
    clearConversation(conversationId);
  }
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
    const row = memorySqlite
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

    forkEverInjected("conv-parent", "conv-child");

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
    forkEverInjected("conv-empty", "conv-child");
    expect(getInjected("conv-child").size).toBe(0);
  });
});

describe("seedEverInjectedFromSlugs", () => {
  test("seeds dedup-only rows with bytes = 0 stamped at the given time", () => {
    seedEverInjectedFromSlugs(
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
    const row = memorySqlite
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
    seedEverInjectedFromSlugs("conv-parent", "conv-child", [], 5_000);
    expect(getInjected("conv-child").size).toBe(0);

    recordInjected(
      "conv-child",
      [{ slug: "topics/page-a", bytes: 100 }],
      1_000,
    );
    seedEverInjectedFromSlugs(
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

describe("memory-side schema", () => {
  test("ensure is idempotent — running twice leaves a usable table", () => {
    // makeDb() already ensured the schema once; run it again.
    ensureMemoryV3EverInjectedSchema(memorySqlite);

    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
  });
});

describe("fail-soft without a memory database", () => {
  test("keeps the last pruned snapshot after a read failure", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));

    memorySqlite.run("DROP TABLE memory_v3_ever_injected");

    expect(() => getPrunedSlugs("conv-1")).not.toThrow();
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
  });

  test("durable reads are empty while pending accounting remains active", () => {
    memoryDbAvailable = false;
    expect(() =>
      recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000),
    ).not.toThrow();
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getInjected("conv-1").size).toBe(0);
    expect(residentBytes("conv-1")).toBe(100);
    expect(() => clearConversation("conv-1")).not.toThrow();
  });

  test("keeps a re-injected card active until its accounting write recovers", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));

    memoryDbAvailable = false;
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 140 }], 3_000);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set());
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getActiveEntries("conv-1")).toEqual([
      { slug: "topics/page-a", bytes: 140, injectedAt: 3_000 },
    ]);
    expect(residentBytes("conv-1")).toBe(140);

    memoryDbAvailable = true;
    expect(getPrunedSlugs("conv-1")).toEqual(new Set());
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: null,
    });
  });

  test("recovers a durable re-injection after runtime state is lost", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);

    memoryDbAvailable = false;
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 140 }], 3_000);
    _resetEverInjectedRuntimeStateForTests();

    memoryDbAvailable = true;
    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 140, injectedAt: 3_000 },
    ]);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set());
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(residentBytes("conv-1")).toBe(140);
  });

  test("retains durable reconciliation until the memory database recovers", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    _resetEverInjectedRuntimeStateForTests();

    memoryDbAvailable = false;
    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 140, injectedAt: 3_000 },
    ]);
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(residentBytes("conv-1")).toBe(140);

    memoryDbAvailable = true;
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(residentBytes("conv-1")).toBe(140);
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: null,
    });
  });

  test("retains a newer prune after queued reconciliation recovers", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    _resetEverInjectedRuntimeStateForTests();

    memoryDbAvailable = false;
    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 100, injectedAt: 1_500 },
    ]);

    memoryDbAvailable = true;
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });

  test("lets an outage-time prune supersede queued durable reconciliation", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    _resetEverInjectedRuntimeStateForTests();

    memoryDbAvailable = false;
    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 140, injectedAt: 3_000 },
    ]);
    markPruned("conv-1", ["topics/page-a"], 4_000);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
    expect(residentBytes("conv-1")).toBe(0);

    memoryDbAvailable = true;
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
    expect(residentBytes("conv-1")).toBe(0);
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: 4_000,
    });
  });

  test("rolls back recovered injection when its queued prune fails", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    _resetEverInjectedRuntimeStateForTests();

    memoryDbAvailable = false;
    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 140, injectedAt: 3_000 },
    ]);
    markPruned("conv-1", ["topics/page-a"], 4_000);
    memorySqlite.run(`
      CREATE TRIGGER fail_recovered_prune
      BEFORE UPDATE ON memory_v3_ever_injected
      WHEN NEW.pruned_at = 4000
      BEGIN
        SELECT RAISE(ABORT, 'failed recovered prune');
      END
    `);

    memoryDbAvailable = true;
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
    expect(residentBytes("conv-1")).toBe(0);
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 100,
      prunedAt: 2_000,
    });

    memorySqlite.run("DROP TRIGGER fail_recovered_prune");
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: 4_000,
    });
  });

  test("lets queued durable reconciliation supersede an older prune", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    _resetEverInjectedRuntimeStateForTests();

    memoryDbAvailable = false;
    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 140, injectedAt: 3_000 },
    ]);
    markPruned("conv-1", ["topics/page-a"], 2_500);
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(residentBytes("conv-1")).toBe(140);

    memoryDbAvailable = true;
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(residentBytes("conv-1")).toBe(140);
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: null,
    });
  });

  test("does not recover a persisted card older than its prune", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    _resetEverInjectedRuntimeStateForTests();

    reconcilePersistedInjections("conv-1", [
      { slug: "topics/page-a", bytes: 100, injectedAt: 1_500 },
    ]);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });
});

describe("fail-soft when the underlying statement fails", () => {
  // The memory connection is present, but the relocated table is gone (a
  // corrupt/dropped table, SQLITE_FULL, I/O error, or SQLITE_BUSY after
  // timeout). Every write must degrade like the null-connection case — log a
  // warning and no-op — rather than throwing out of the turn.
  test("write paths no-op when the target table is missing", () => {
    memorySqlite.query("DROP TABLE memory_v3_ever_injected").run();

    expect(() =>
      recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000),
    ).not.toThrow();
    expect(() => markPruned("conv-1", ["topics/page-a"], 2_000)).not.toThrow();
    expect(() => clearConversation("conv-1")).not.toThrow();
    expect(() => forkEverInjected("conv-parent", "conv-child")).not.toThrow();
    expect(() =>
      seedEverInjectedFromSlugs(
        "conv-parent",
        "conv-child",
        ["topics/page-a"],
        5_000,
      ),
    ).not.toThrow();
  });

  test("retries a failed re-injection write before reading tombstones", () => {
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 100 }], 1_000);
    markPruned("conv-1", ["topics/page-a"], 2_000);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));

    memorySqlite.run(`
      CREATE TRIGGER fail_reinjection
      BEFORE UPDATE ON memory_v3_ever_injected
      WHEN NEW.pruned_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'failed re-injection');
      END
    `);
    recordInjected("conv-1", [{ slug: "topics/page-a", bytes: 140 }], 3_000);
    expect(getPrunedSlugs("conv-1")).toEqual(new Set());
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["topics/page-a"]));
    expect(residentBytes("conv-1")).toBe(140);
    expect(getInjected("conv-1").get("topics/page-a")?.prunedAt).toBe(2_000);

    memorySqlite.run("DROP TRIGGER fail_reinjection");
    expect(getPrunedSlugs("conv-1")).toEqual(new Set());
    expect(getInjected("conv-1").get("topics/page-a")).toEqual({
      bytes: 140,
      prunedAt: null,
    });
  });
});
