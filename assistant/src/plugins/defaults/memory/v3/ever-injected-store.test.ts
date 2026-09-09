/**
 * Tests for `ever-injected-store.ts`, memory-v3's per-conversation record of
 * injected sections:
 *   - record/get/active-set round-trip at `(slug, key)` grain and re-record
 *     clearing `pruned_at`;
 *   - `markPruned` excluding exactly the named pair from the active set and
 *     `residentBytes`, leaving sibling sections of the page resident;
 *   - `touchSelected` stamping `last_selected_at` on exactly the named rows
 *     (batched past SQLite's expression depth), the stamp `recordInjected`
 *     sets for new and re-recorded rows and a full fork copies;
 *   - `clearConversation` (compaction reset), the conversation's legacy card
 *     rows included so no later copy re-imports them;
 *   - fork hooks: full-row copy (pruned state included) and truncated-fork
 *     seeding from inherited block sections (bytes measured from each
 *     inherited span, tombstones carried over);
 *   - migration idempotence (run twice), and the one-shot legacy copy the
 *     lazy per-connection ensure records in the checkpoint ledger.
 *
 * The rows live on the dedicated memory connection, resolved via
 * `getMemorySqlite`, stubbed to an in-memory DB carrying the table's schema,
 * with `memoryDbAvailable` toggled to `null` for the fail-soft case; the
 * checkpoint ledger the ensure records its copy in rides `getDb`, stubbed to
 * an in-memory main DB carrying `memory_checkpoints`.
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
import { wrapMemoryBlock } from "../memory-marker.js";
import { injectedSectionHeader } from "../substrate/injected-block-slugs.js";
import { renderedBytes } from "../substrate/injected-block-slugs.js";
import {
  ensureMemoryV3InjectedSectionsSchema,
  ensureMemoryV3PluginSchema,
  SECTIONS_LEGACY_COPY_DONE_KEY,
} from "./plugin-schema.js";
import type { InjectedBlock } from "./types.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};

let storeMockActive = false;
let memoryDbAvailable = true;

let memorySqlite: Database;
/** The main connection, carrying the checkpoint ledger the sections ensure
 *  records its one-shot legacy copy in. */
let mainSqlite: Database;
makeDb();
function makeDb() {
  memorySqlite = new Database(":memory:");
  ensureMemoryV3InjectedSectionsSchema(memorySqlite);
  mainSqlite = new Database(":memory:");
  mainSqlite.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getDb: () =>
    storeMockActive ? drizzle(mainSqlite, { schema }) : realDb.getDb(),
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
  clearConversation,
  forkEverInjected,
  getActiveEntries,
  getActiveSections,
  getInjected,
  getPrunedSections,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  recordInjected,
  residentBytes,
  sectionRefSetHas,
  seedEverInjectedFromBlocks,
  touchSelected,
} = await import("./ever-injected-store.js");

beforeEach(() => {
  storeMockActive = true;
  memoryDbAvailable = true;
  makeDb();
});

afterAll(() => {
  storeMockActive = false;
});

/** Project the oracle rows down to the fields a test asserts on. */
function summary(conversationId: string) {
  return getInjected(conversationId).map(({ slug, key, bytes, prunedAt }) => ({
    slug,
    key,
    bytes,
    prunedAt,
  }));
}

/** The conversation's rows in the legacy card table, by slug. */
function legacySlugs(conversationId: string): string[] {
  return (
    memorySqlite
      .query(
        `SELECT slug FROM memory_v3_ever_injected
         WHERE conversation_id = ? ORDER BY slug`,
      )
      .all(conversationId) as Array<{ slug: string }>
  ).map((row) => row.slug);
}

/** Whether the ledger on the main connection records the legacy copy. */
function legacyCopyRecorded(): boolean {
  return (
    mainSqlite
      .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
      .get(SECTIONS_LEGACY_COPY_DONE_KEY) != null
  );
}

describe("metadata key constant", () => {
  test("exports the v3 injected-block metadata key", () => {
    expect(MEMORY_V3_INJECTED_BLOCK_METADATA_KEY).toBe("memoryV3InjectedBlock");
  });
});

describe("recordInjected / getInjected / getActiveSections", () => {
  test("round-trips the recorded entries at (slug, key) grain", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 80 },
        { slug: "topics/page-b", key: "Design#1", bytes: 250 },
      ],
      1_000,
    );

    expect(summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 100, prunedAt: null },
      { slug: "topics/page-a", key: "Notes", bytes: 80, prunedAt: null },
      { slug: "topics/page-b", key: "Design#1", bytes: 250, prunedAt: null },
    ]);
    // The turn that injects a section selected it.
    expect(getInjected("conv-1").map((row) => row.lastSelectedAt)).toEqual([
      1_000, 1_000, 1_000,
    ]);
    const active = getActiveSections("conv-1");
    expect(active).toEqual(
      new Map([
        ["topics/page-a", new Set(["", "Notes"])],
        ["topics/page-b", new Set(["Design#1"])],
      ]),
    );
    expect(sectionRefSetHas(active, "topics/page-a", "Notes")).toBe(true);
    expect(sectionRefSetHas(active, "topics/page-a", "Design")).toBe(false);
    expect(sectionRefSetHas(active, "topics/page-c", "")).toBe(false);
    // Other conversations see nothing.
    expect(getInjected("conv-other")).toEqual([]);
    expect(getActiveSections("conv-other").size).toBe(0);
  });

  test("re-recording a pruned section clears pruned_at and refreshes bytes, injected_at, and last_selected_at", () => {
    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "Notes", bytes: 100 }],
      1_000,
    );
    markPruned("conv-1", [{ slug: "topics/page-a", key: "Notes" }], 2_000);
    expect(summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "Notes", bytes: 100, prunedAt: 2_000 },
    ]);

    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "Notes", bytes: 140 }],
      3_000,
    );

    expect(getInjected("conv-1")).toEqual([
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 140,
        injectedAt: 3_000,
        lastSelectedAt: 3_000,
        prunedAt: null,
      },
    ]);
    expect(getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set(["Notes"])]]),
    );
  });

  test("empty entries are a no-op", () => {
    recordInjected("conv-1", []);
    expect(getInjected("conv-1")).toEqual([]);
  });
});

describe("markPruned / residentBytes / getPrunedSections", () => {
  test("pruned rows leave the active set and resident bytes but stay on record; siblings stay resident", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 250 },
        { slug: "topics/page-b", key: "", bytes: 50 },
      ],
      1_000,
    );
    expect(residentBytes("conv-1")).toBe(400);

    markPruned(
      "conv-1",
      [
        { slug: "topics/page-a", key: "" },
        { slug: "topics/page-b", key: "" },
      ],
      2_000,
    );

    expect(getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set(["Notes"])]]),
    );
    expect(getActiveEntries("conv-1")).toEqual([
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 250,
        injectedAt: 1_000,
        lastSelectedAt: 1_000,
      },
    ]);
    expect(getPrunedSections("conv-1")).toEqual(
      new Map([
        ["topics/page-a", new Set([""])],
        ["topics/page-b", new Set([""])],
      ]),
    );
    expect(residentBytes("conv-1")).toBe(250);
    // Rows are never deleted — the record stays auditable.
    expect(getInjected("conv-1")).toHaveLength(3);
  });

  test("tombstones a plan far larger than one batch (and SQLite's expression depth) in one call", () => {
    const refs = Array.from({ length: 1_100 }, (_, i) => ({
      slug: `topics/page-${i}`,
      key: i % 2 === 0 ? "" : "Notes",
    }));
    recordInjected(
      "conv-1",
      refs.map((ref) => ({ ...ref, bytes: 1 })),
      1_000,
    );
    recordInjected("conv-1", [{ slug: "survivor", key: "", bytes: 7 }], 1_000);
    expect(residentBytes("conv-1")).toBe(1_107);

    markPruned("conv-1", refs, 2_000);

    expect(residentBytes("conv-1")).toBe(7);
    expect(getActiveSections("conv-1")).toEqual(
      new Map([["survivor", new Set([""])]]),
    );
    expect(getPrunedSections("conv-1").size).toBe(1_100);
    expect(
      getInjected("conv-1").filter((row) => row.prunedAt === 2_000),
    ).toHaveLength(1_100);
  });

  test("empty ref list is a no-op and residentBytes is 0 for unknown conversations", () => {
    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    markPruned("conv-1", [], 2_000);
    expect(residentBytes("conv-1")).toBe(100);
    expect(residentBytes("conv-unknown")).toBe(0);
  });
});

describe("touchSelected", () => {
  /** Each row's selection stamp, by `(slug, key)`. */
  function stamps(conversationId: string) {
    return getInjected(conversationId).map(({ slug, key, lastSelectedAt }) => [
      slug,
      key,
      lastSelectedAt,
    ]);
  }

  test("stamps exactly the named rows, leaving injected_at and other conversations alone; an unknown ref is a no-op", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 80 },
        { slug: "topics/page-b", key: "", bytes: 50 },
      ],
      1_000,
    );
    recordInjected(
      "conv-2",
      [{ slug: "topics/page-a", key: "Notes", bytes: 80 }],
      1_000,
    );

    touchSelected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "Notes" },
        { slug: "topics/page-b", key: "" },
        { slug: "topics/page-c", key: "" },
      ],
      2_000,
    );

    expect(stamps("conv-1")).toEqual([
      ["topics/page-a", "", 1_000],
      ["topics/page-a", "Notes", 2_000],
      ["topics/page-b", "", 2_000],
    ]);
    expect(stamps("conv-2")).toEqual([["topics/page-a", "Notes", 1_000]]);
    expect(getInjected("conv-1").every((row) => row.injectedAt === 1_000)).toBe(
      true,
    );
  });

  test("stamps a ref list far larger than one batch (and SQLite's expression depth) in one call", () => {
    const refs = Array.from({ length: 1_100 }, (_, i) => ({
      slug: `topics/page-${i}`,
      key: i % 2 === 0 ? "" : "Notes",
    }));
    recordInjected(
      "conv-1",
      refs.map((ref) => ({ ...ref, bytes: 1 })),
      1_000,
    );

    touchSelected("conv-1", refs, 2_000);

    expect(
      getInjected("conv-1").filter((row) => row.lastSelectedAt === 2_000),
    ).toHaveLength(1_100);
  });

  test("empty ref list is a no-op", () => {
    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    touchSelected("conv-1", [], 2_000);
    expect(stamps("conv-1")).toEqual([["topics/page-a", "", 1_000]]);
  });
});

describe("clearConversation", () => {
  test("deletes all rows for the conversation only", () => {
    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    recordInjected(
      "conv-2",
      [{ slug: "topics/page-b", key: "", bytes: 200 }],
      1_000,
    );

    clearConversation("conv-1");

    expect(getInjected("conv-1")).toEqual([]);
    expect(getInjected("conv-2")).toHaveLength(1);
  });

  test("deletes the conversation's legacy card rows too, so a copy that runs after the reset re-imports nothing for it", () => {
    ensureMemoryV3EverInjectedSchema(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, NULL),
        ('conv-2', 'topics/page-a', 3000, 100, NULL)
    `);
    // The store's first use of this connection copies the legacy rows in.
    expect(summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 0, prunedAt: null },
      { slug: "topics/page-b", key: "", bytes: 0, prunedAt: null },
    ]);
    expect(legacyCopyRecorded()).toBe(true);

    clearConversation("conv-1");

    expect(getInjected("conv-1")).toEqual([]);
    expect(legacySlugs("conv-1")).toEqual([]);
    expect(legacySlugs("conv-2")).toEqual(["topics/page-a"]);
    expect(getInjected("conv-2")).toHaveLength(1);

    // A copy that runs again, its record lost, as a fresh connection's
    // ensure would: nothing of conv-1 is left to bring back.
    mainSqlite.exec(`DELETE FROM memory_checkpoints`);
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    expect(getInjected("conv-1")).toEqual([]);
    expect(summary("conv-2")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 0, prunedAt: null },
    ]);
    expect(legacyCopyRecorded()).toBe(true);
  });
});

describe("forkEverInjected", () => {
  test("copies the parent's full record, pruned state and selection stamps included", () => {
    recordInjected(
      "conv-parent",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 250 },
      ],
      1_000,
    );
    markPruned("conv-parent", [{ slug: "topics/page-a", key: "Notes" }], 2_000);
    touchSelected("conv-parent", [{ slug: "topics/page-a", key: "" }], 3_000);

    forkEverInjected("conv-parent", "conv-child");

    expect(getInjected("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: 100,
        injectedAt: 1_000,
        lastSelectedAt: 3_000,
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 250,
        injectedAt: 1_000,
        lastSelectedAt: 1_000,
        prunedAt: 2_000,
      },
    ]);
    expect(residentBytes("conv-child")).toBe(100);
    // Parent record is untouched.
    expect(getInjected("conv-parent")).toHaveLength(2);
  });

  test("is a no-op when the parent has no rows", () => {
    forkEverInjected("conv-empty", "conv-child");
    expect(getInjected("conv-child")).toEqual([]);
  });
});

/** An inherited block with the format its row's metadata recorded. */
const current = (inner: string): InjectedBlock => ({
  inner,
  format: "current",
});
const legacy = (inner: string): InjectedBlock => ({ inner, format: "legacy" });

describe("seedEverInjectedFromBlocks", () => {
  const leadA = `${injectedSectionHeader("topics/page-a", "")}\nLead A`;
  const notesA = `${injectedSectionHeader("topics/page-a", "Notes")}\nNotes A`;
  const blockA = `${leadA}\n\n${notesA}`;
  const designB = `${injectedSectionHeader("topics/page-b", "Design#1")}\nDesign B`;

  test("seeds a row per inherited section, stamped at the given time with no selection stamp, with the bytes of its inherited span", () => {
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA), current(wrapMemoryBlock(designB))],
      5_000,
    );

    expect(getInjected("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        injectedAt: 5_000,
        lastSelectedAt: null,
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesA),
        injectedAt: 5_000,
        lastSelectedAt: null,
        prunedAt: null,
      },
      {
        slug: "topics/page-b",
        key: "Design#1",
        bytes: renderedBytes(designB),
        injectedAt: 5_000,
        lastSelectedAt: null,
        prunedAt: null,
      },
    ]);
    // The child's resident accounting starts at what it inherited.
    expect(residentBytes("conv-child")).toBe(
      renderedBytes(leadA) + renderedBytes(notesA) + renderedBytes(designB),
    );
  });

  test("a section inherited from several blocks takes its latest span; an escaped forged header seeds no phantom row", () => {
    const notesAgain = `${injectedSectionHeader("topics/page-a", "Notes")}\nNotes A, re-injected after a prune\n\\# memory/concepts/phantom.md`;
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA), current(notesAgain)],
      5_000,
    );

    expect(summary("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesAgain),
        prunedAt: null,
      },
    ]);
  });

  test("seeds inherited capability chunks at zero bytes under the empty key, as the injector records them", () => {
    const block = [
      leadA,
      "",
      "# Skills",
      "hint",
      "",
      "# Skill: meet-join",
      "Join a meeting.",
      "",
      "# CLI command: export",
      "Export a conversation.",
    ].join("\n");
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(block)],
      5_000,
    );

    expect(summary("conv-child")).toEqual([
      { slug: "cli-commands/export", key: "", bytes: 0, prunedAt: null },
      { slug: "skills/meet-join", key: "", bytes: 0, prunedAt: null },
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        prunedAt: null,
      },
    ]);
    expect(getActiveSections("conv-child")).toEqual(
      new Map([
        ["cli-commands/export", new Set([""])],
        ["skills/meet-join", new Set([""])],
        ["topics/page-a", new Set([""])],
      ]),
    );
    expect(residentBytes("conv-child")).toBe(renderedBytes(leadA));
  });

  test("a legacy block (a pre-stamp row's) seeds nothing; the current blocks beside it seed as usual", () => {
    const card = [
      injectedSectionHeader("topics/page-a", ""),
      "# Page A",
      "lead prose",
      "",
      "# memory/concepts/example.md",
      "more lead prose",
      "",
      "[sections: §Notes · §Design]",
    ].join("\n");
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [legacy(`preamble\n\n${card}`), current(designB)],
      5_000,
    );

    expect(summary("conv-child")).toEqual([
      {
        slug: "topics/page-b",
        key: "Design#1",
        bytes: renderedBytes(designB),
        prunedAt: null,
      },
    ]);

    // Legacy blocks alone: a no-op.
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child-legacy-only",
      [legacy(`preamble\n\n${card}`)],
      5_000,
    );
    expect(getInjected("conv-child-legacy-only")).toEqual([]);
  });

  test("carries the parent's pruned_at tombstones for inherited sections", () => {
    // Parent injected both sections of page-a, then pruned Notes: the
    // metadata block the child inherits still contains the Notes section,
    // so the scan seeds both, but Notes must arrive tombstoned, not active,
    // or the child's rehydration would resurrect a section the parent's live
    // view lost.
    recordInjected(
      "conv-parent",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 200 },
      ],
      1_000,
    );
    markPruned("conv-parent", [{ slug: "topics/page-a", key: "Notes" }], 2_000);

    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA)],
      5_000,
    );

    expect(summary("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesA),
        prunedAt: 2_000,
      },
    ]);
    expect(getActiveSections("conv-child")).toEqual(
      new Map([["topics/page-a", new Set([""])]]),
    );
    // A tombstoned seed carries its bytes but stays out of the resident sum.
    expect(residentBytes("conv-child")).toBe(renderedBytes(leadA));

    // Re-selection clears the inherited tombstone, same as in the parent.
    recordInjected(
      "conv-child",
      [{ slug: "topics/page-a", key: "Notes", bytes: 50 }],
      6_000,
    );
    expect(getActiveSections("conv-child")).toEqual(
      new Map([["topics/page-a", new Set(["", "Notes"])]]),
    );
  });

  test("is a no-op for blocks with no headers and never overwrites existing rows", () => {
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current("no headers")],
      5_000,
    );
    expect(getInjected("conv-child")).toEqual([]);

    recordInjected(
      "conv-child",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA)],
      5_000,
    );
    expect(summary("conv-child")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 100, prunedAt: null },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesA),
        prunedAt: null,
      },
    ]);
  });
});

describe("memory-side schema", () => {
  test("a store call on a fresh memory connection creates the table itself (the lazy per-connection ensure)", () => {
    memorySqlite = new Database(":memory:");

    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );

    expect(getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set([""])]]),
    );
  });

  test("the plugin-init ensure creates the table and no-ops when the memory database is unavailable", () => {
    memorySqlite = new Database(":memory:");
    ensureMemoryV3PluginSchema();
    expect(
      memorySqlite
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_v3_injected_sections'`,
        )
        .get(),
    ).not.toBeNull();

    memoryDbAvailable = false;
    expect(() => ensureMemoryV3PluginSchema()).not.toThrow();
  });

  test("ensure is idempotent — running twice leaves a usable table", () => {
    // makeDb() already ensured the schema once; run it again.
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    expect(getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set([""])]]),
    );
  });

  test("the lazy per-connection ensure copies the legacy card rows once, recording the copy in the checkpoint ledger, and a later ensure skips it", () => {
    ensureMemoryV3EverInjectedSchema(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);
    expect(legacyCopyRecorded()).toBe(false);

    expect(summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 0, prunedAt: null },
    ]);
    expect(legacyCopyRecorded()).toBe(true);

    // The record, not the legacy rows, is what a later ensure consults.
    recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 90 }],
      2_000,
    );
    memorySqlite.query("DELETE FROM memory_v3_injected_sections").run();
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);
    expect(getInjected("conv-1")).toEqual([]);
  });
});

describe("fail-soft without a memory database", () => {
  test("reads return empty and writes no-op when the memory DB is unavailable", () => {
    memoryDbAvailable = false;
    expect(() =>
      recordInjected(
        "conv-1",
        [{ slug: "topics/page-a", key: "", bytes: 100 }],
        1_000,
      ),
    ).not.toThrow();
    expect(getActiveSections("conv-1").size).toBe(0);
    expect(getPrunedSections("conv-1").size).toBe(0);
    expect(getInjected("conv-1")).toEqual([]);
    expect(residentBytes("conv-1")).toBe(0);
    expect(() =>
      touchSelected("conv-1", [{ slug: "topics/page-a", key: "" }], 2_000),
    ).not.toThrow();
    expect(() => clearConversation("conv-1")).not.toThrow();
  });
});

describe("fail-soft when the underlying statement fails", () => {
  // The memory connection is present, but the table is gone (a
  // corrupt/dropped table, SQLITE_FULL, I/O error, or SQLITE_BUSY after
  // timeout). Every write must degrade like the null-connection case — log a
  // warning and no-op — rather than throwing out of the turn.
  test("read paths return empty when the target table is missing (memory stays on, dedup off)", () => {
    memorySqlite.query("DROP TABLE memory_v3_injected_sections").run();

    expect(getActiveSections("conv-1").size).toBe(0);
    expect(getPrunedSections("conv-1").size).toBe(0);
    expect(getActiveEntries("conv-1")).toEqual([]);
    expect(getInjected("conv-1")).toEqual([]);
    expect(residentBytes("conv-1")).toBe(0);
  });

  test("write paths no-op when the target table is missing", () => {
    memorySqlite.query("DROP TABLE memory_v3_injected_sections").run();

    expect(() =>
      recordInjected(
        "conv-1",
        [{ slug: "topics/page-a", key: "", bytes: 100 }],
        1_000,
      ),
    ).not.toThrow();
    expect(() =>
      markPruned("conv-1", [{ slug: "topics/page-a", key: "" }], 2_000),
    ).not.toThrow();
    expect(() =>
      touchSelected("conv-1", [{ slug: "topics/page-a", key: "" }], 2_000),
    ).not.toThrow();
    expect(() => clearConversation("conv-1")).not.toThrow();
    expect(() => forkEverInjected("conv-parent", "conv-child")).not.toThrow();
    expect(() =>
      seedEverInjectedFromBlocks(
        "conv-parent",
        "conv-child",
        [current(injectedSectionHeader("topics/page-a", ""))],
        5_000,
      ),
    ).not.toThrow();
  });
});
