/**
 * The memory-v3 plugin's own schema on the memory connection
 * (`v3/plugin-schema.ts`): `memory_v3_injected_sections` is created
 * idempotently, its `last_selected_at` column added to a table created
 * without it, and seeded once per database from the card-grain
 * `memory_v3_ever_injected`, one zero-byte lead entry per legacy row, with
 * the copy recorded in the checkpoint ledger; `deleteLegacyCardRows` clears
 * a conversation's legacy rows for the compaction reset; `memory_v3_pools`
 * is created idempotently; the selection log's `section_key` column is added
 * to the `memory_v3_selections` table migration 338 creates. Every ensure
 * takes the raw handle, and the sections ensure its ledger, so these tests
 * run on in-memory databases (a file-backed one where a second connection
 * matters) with no connection stub, and the once-per-connection wrapper the
 * stores share is exercised on plain handles the same way.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { ensureMemoryV3SelectionsSchema } from "../../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import { ensureMemoryV3EverInjectedSchema } from "../../../../../persistence/migrations/345-move-memory-v3-ever-injected-to-memory-db.js";
import {
  deleteLegacyCardRows,
  ensureMemoryV3InjectedSectionsSchema,
  ensureMemoryV3PoolsSchema,
  ensureMemoryV3SelectionsSectionKeyOnce,
  ensureOncePerConnection,
  SECTIONS_LEGACY_COPY_DONE_KEY,
} from "../plugin-schema.js";

interface Row {
  conversation_id: string;
  slug: string;
  section_key: string;
  injected_at: number;
  bytes: number;
  pruned_at: number | null;
}

function rows(db: Database): Row[] {
  return db
    .query(
      `SELECT conversation_id, slug, section_key, injected_at, bytes, pruned_at
       FROM memory_v3_injected_sections ORDER BY conversation_id, slug, section_key`,
    )
    .all() as Row[];
}

function legacyRows(
  db: Database,
): Array<{ conversation_id: string; slug: string }> {
  return db
    .query(
      `SELECT conversation_id, slug FROM memory_v3_ever_injected
       ORDER BY conversation_id, slug`,
    )
    .all() as Array<{ conversation_id: string; slug: string }>;
}

function objectNames(db: Database, type: "table" | "index"): string[] {
  return (
    db
      .query(`SELECT name FROM sqlite_master WHERE type = ?`)
      .all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

/** A map-backed checkpoint ledger whose reads or writes can be made to
 *  fail, as a main database the process cannot reach makes the real one. */
function ledger() {
  const values = new Map<string, string>();
  const fails = { reads: false, writes: false };
  const api = {
    get: (key: string): string | null => {
      if (fails.reads) {
        throw new Error("no such table: memory_checkpoints");
      }
      return values.get(key) ?? null;
    },
    set: (key: string, value: string): void => {
      if (fails.writes) {
        throw new Error("database is locked");
      }
      values.set(key, value);
    },
  };
  return { ...api, values, fails };
}

let memorySqlite: Database;

/** The superseded card-grain table exactly as migration 345 leaves it on
 *  the memory connection (frozen; nothing writes it), the copy's source. */
function createLegacyCardsTable(db: Database): void {
  ensureMemoryV3EverInjectedSchema(db);
}

beforeEach(() => {
  memorySqlite = new Database(":memory:");
});

describe("ensureMemoryV3InjectedSectionsSchema", () => {
  test("creates the table and its conversation index when no legacy table exists, recording nothing", () => {
    const checkpoints = ledger();

    ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints);

    expect(objectNames(memorySqlite, "table")).toContain(
      "memory_v3_injected_sections",
    );
    expect(objectNames(memorySqlite, "index")).toContain(
      "idx_memory_v3_injected_sections_conv",
    );
    expect(rows(memorySqlite)).toEqual([]);
    expect(checkpoints.values.size).toBe(0);
  });

  test("copies every legacy card row as that page's lead entry at zero bytes, injected_at and pruned_at preserved, and records the copy", () => {
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, 3000),
        ('conv-2', 'topics/page-a', 4000, 0, NULL)
    `);
    const checkpoints = ledger();

    ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints);

    expect(rows(memorySqlite)).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 1000,
        bytes: 0,
        pruned_at: null,
      },
      {
        conversation_id: "conv-1",
        slug: "topics/page-b",
        section_key: "",
        injected_at: 2000,
        bytes: 0,
        pruned_at: 3000,
      },
      {
        conversation_id: "conv-2",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 4000,
        bytes: 0,
        pruned_at: null,
      },
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
    // The legacy table is left in place, its rows untouched.
    expect(legacyRows(memorySqlite)).toHaveLength(3);
  });

  test("copies once per database: a second connection's ensure finds the copy on record and re-imports nothing", () => {
    // File-backed, so a second connection sees the first one's rows, as a
    // later process does.
    const dir = mkdtempSync(join(tmpdir(), "memory-v3-plugin-schema-"));
    try {
      const path = join(dir, "assistant-memory.db");
      const checkpoints = ledger();
      const first = new Database(path);
      createLegacyCardsTable(first);
      first.exec(/*sql*/ `
        INSERT INTO memory_v3_ever_injected
          (conversation_id, slug, injected_at, bytes, pruned_at)
        VALUES
          ('conv-1', 'topics/page-a', 1000, 120, NULL),
          ('conv-2', 'topics/page-a', 2000, 120, NULL)
      `);
      ensureMemoryV3InjectedSectionsSchema(first, checkpoints);
      expect(rows(first).map((row) => row.conversation_id)).toEqual([
        "conv-1",
        "conv-2",
      ]);
      // Compaction cleared conv-1's record. Its legacy rows stay here on
      // purpose: the record alone must keep the copy from bringing them
      // back.
      first.exec(/*sql*/ `
        DELETE FROM memory_v3_injected_sections WHERE conversation_id = 'conv-1'
      `);
      first.close();

      const second = new Database(path);
      ensureMemoryV3InjectedSectionsSchema(second, checkpoints);

      expect(rows(second).map((row) => row.conversation_id)).toEqual([
        "conv-2",
      ]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable ledger skips the copy rather than repeating it; a later ensure copies once the ledger reads", () => {
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);
    const checkpoints = ledger();
    checkpoints.fails.reads = true;

    expect(() =>
      ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints),
    ).not.toThrow();

    // The table is usable; the copy waits.
    expect(objectNames(memorySqlite, "table")).toContain(
      "memory_v3_injected_sections",
    );
    expect(rows(memorySqlite)).toEqual([]);
    expect(checkpoints.values.size).toBe(0);

    checkpoints.fails.reads = false;
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints);

    expect(rows(memorySqlite).map((row) => row.slug)).toEqual([
      "topics/page-a",
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
  });

  test("a copy whose record cannot be written stays in place and is repeated until the record lands, neither duplicating rows nor overwriting entries refreshed since", () => {
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, 5000)
    `);
    const checkpoints = ledger();
    checkpoints.fails.writes = true;

    expect(() =>
      ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints),
    ).not.toThrow();
    expect(rows(memorySqlite).map((row) => row.slug)).toEqual([
      "topics/page-a",
    ]);
    expect(checkpoints.values.size).toBe(0);
    // The section store re-injects the lead after the copy: pruned_at clears.
    memorySqlite.exec(/*sql*/ `
      UPDATE memory_v3_injected_sections
      SET injected_at = 9000, bytes = 150, pruned_at = NULL
      WHERE conversation_id = 'conv-1' AND slug = 'topics/page-a'
    `);

    checkpoints.fails.writes = false;
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints);

    expect(rows(memorySqlite)).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 9000,
        bytes: 150,
        pruned_at: null,
      },
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
  });

  test("creates a fresh table with last_selected_at, and adds it to a table created without it, keeping its rows", () => {
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, ledger());
    expect(columnNames(memorySqlite, "memory_v3_injected_sections")).toContain(
      "last_selected_at",
    );

    // A table an earlier build created, carrying a row.
    const older = new Database(":memory:");
    older.exec(/*sql*/ `
      CREATE TABLE memory_v3_injected_sections (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        section_key TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER,
        PRIMARY KEY (conversation_id, slug, section_key)
      )
    `);
    older.exec(/*sql*/ `
      INSERT INTO memory_v3_injected_sections
        (conversation_id, slug, section_key, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 'Notes', 1000, 120, NULL)
    `);

    ensureMemoryV3InjectedSectionsSchema(older, ledger());

    expect(columnNames(older, "memory_v3_injected_sections")).toContain(
      "last_selected_at",
    );
    expect(
      older
        .query(
          `SELECT slug, section_key, bytes, last_selected_at
           FROM memory_v3_injected_sections`,
        )
        .all(),
    ).toEqual([
      {
        slug: "topics/page-a",
        section_key: "Notes",
        bytes: 120,
        last_selected_at: null,
      },
    ]);
    // A second ensure adds nothing.
    const columns = columnNames(older, "memory_v3_injected_sections");
    ensureMemoryV3InjectedSectionsSchema(older, ledger());
    expect(columnNames(older, "memory_v3_injected_sections")).toEqual(columns);
  });

  test("a table carrying an extra nullable column is left as is and still takes the copy", () => {
    memorySqlite.exec(/*sql*/ `
      CREATE TABLE memory_v3_injected_sections (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        section_key TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER,
        frozen_card_bytes INTEGER,
        PRIMARY KEY (conversation_id, slug, section_key)
      )
    `);
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    ensureMemoryV3InjectedSectionsSchema(memorySqlite, ledger());

    expect(rows(memorySqlite).map((row) => [row.slug, row.bytes])).toEqual([
      ["topics/page-a", 0],
    ]);
  });

  test("a legacy table that appears after the first ensure is copied by the next one", () => {
    const checkpoints = ledger();
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints);
    expect(rows(memorySqlite)).toEqual([]);
    expect(checkpoints.values.size).toBe(0);
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    ensureMemoryV3InjectedSectionsSchema(memorySqlite, checkpoints);

    expect(rows(memorySqlite).map((row) => [row.slug, row.bytes])).toEqual([
      ["topics/page-a", 0],
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
  });
});

describe("deleteLegacyCardRows", () => {
  test("deletes only the conversation's legacy rows, and no-ops without the table", () => {
    expect(() => deleteLegacyCardRows(memorySqlite, "conv-1")).not.toThrow();

    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, 3000),
        ('conv-2', 'topics/page-a', 4000, 0, NULL)
    `);

    deleteLegacyCardRows(memorySqlite, "conv-1");

    expect(legacyRows(memorySqlite)).toEqual([
      { conversation_id: "conv-2", slug: "topics/page-a" },
    ]);
  });

  test("keeps a compacted conversation's leads out of a copy that runs after the reset", () => {
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-2', 'topics/page-a', 2000, 120, NULL)
    `);
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, ledger());
    // The compaction reset: the section record and the legacy rows go
    // together.
    memorySqlite.exec(/*sql*/ `
      DELETE FROM memory_v3_injected_sections WHERE conversation_id = 'conv-1'
    `);
    deleteLegacyCardRows(memorySqlite, "conv-1");

    // A copy with no record of the first (a fresh ledger) finds nothing of
    // conv-1 to bring back.
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, ledger());

    expect(rows(memorySqlite).map((row) => row.conversation_id)).toEqual([
      "conv-2",
    ]);
  });
});

describe("ensureMemoryV3PoolsSchema", () => {
  test("creates the table and its indexes, idempotently", () => {
    ensureMemoryV3PoolsSchema(memorySqlite);
    ensureMemoryV3PoolsSchema(memorySqlite);

    expect(objectNames(memorySqlite, "table")).toContain("memory_v3_pools");
    expect(objectNames(memorySqlite, "index")).toEqual(
      expect.arrayContaining([
        "idx_memory_v3_pools_message",
        "idx_memory_v3_pools_conv",
      ]),
    );
  });
});

describe("ensureMemoryV3SelectionsSectionKeyOnce", () => {
  test("adds section_key to the table migration 338 creates, keeping its rows", () => {
    ensureMemoryV3SelectionsSchema(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_selections
        (conversation_id, turn, slug, source, created_at, section_ordinal,
         section_title)
      VALUES ('conv-1', 0, 'topics/page-a', 'needle', 1000, 2, 'Notes')
    `);

    ensureMemoryV3SelectionsSectionKeyOnce(memorySqlite);

    expect(columnNames(memorySqlite, "memory_v3_selections")).toContain(
      "section_key",
    );
    expect(
      memorySqlite
        .query(
          `SELECT slug, section_title, section_key FROM memory_v3_selections`,
        )
        .all(),
    ).toEqual([
      { slug: "topics/page-a", section_title: "Notes", section_key: null },
    ]);
  });

  test("is a no-op on a table that already has the column (another process's connection to the same database)", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-v3-selections-"));
    const path = join(dir, "assistant-memory.db");
    const first = new Database(path);
    const second = new Database(path);
    try {
      ensureMemoryV3SelectionsSchema(first);
      ensureMemoryV3SelectionsSectionKeyOnce(first);
      const columns = columnNames(first, "memory_v3_selections");

      ensureMemoryV3SelectionsSectionKeyOnce(second);

      expect(columnNames(second, "memory_v3_selections")).toEqual(columns);
      expect(columns.filter((name) => name === "section_key")).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails open on a connection without the table and retries once the table is there", () => {
    expect(() =>
      ensureMemoryV3SelectionsSectionKeyOnce(memorySqlite),
    ).not.toThrow();
    expect(objectNames(memorySqlite, "table")).not.toContain(
      "memory_v3_selections",
    );

    ensureMemoryV3SelectionsSchema(memorySqlite);
    ensureMemoryV3SelectionsSectionKeyOnce(memorySqlite);

    expect(columnNames(memorySqlite, "memory_v3_selections")).toContain(
      "section_key",
    );
  });
});

describe("ensureOncePerConnection", () => {
  test("runs the ensure once per connection, again for a new connection, and retries a connection whose ensure failed", () => {
    const runs: unknown[] = [];
    let failing = true;
    const ensureOnce = ensureOncePerConnection((raw) => {
      runs.push(raw);
      if (failing) {
        throw new Error("no such table");
      }
    }, "degraded");

    ensureOnce(memorySqlite);
    ensureOnce(memorySqlite);
    expect(runs).toHaveLength(2);

    failing = false;
    ensureOnce(memorySqlite);
    ensureOnce(memorySqlite);
    expect(runs).toHaveLength(3);

    const reopened = new Database(":memory:");
    ensureOnce(reopened);
    ensureOnce(reopened);
    expect(runs).toHaveLength(4);
  });
});
