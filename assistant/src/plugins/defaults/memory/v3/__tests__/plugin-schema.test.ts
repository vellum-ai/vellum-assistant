/**
 * The memory-v3 plugin's own schema on the memory connection
 * (`v3/plugin-schema.ts`): `memory_v3_injected_sections` is created
 * idempotently and seeded from the card-grain `memory_v3_ever_injected`, one
 * lead entry per legacy row; `memory_v3_pools` is created idempotently. Both
 * ensures take the raw handle, so these tests run on in-memory databases with
 * no connection stub.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  ensureMemoryV3InjectedSectionsSchema,
  ensureMemoryV3PoolsSchema,
} from "../plugin-schema.js";

interface Row {
  conversation_id: string;
  slug: string;
  section_key: string;
  injected_at: number;
  bytes: number;
  pruned_at: number | null;
  frozen_card_bytes: number | null;
}

function rows(db: Database): Row[] {
  return db
    .query(
      `SELECT conversation_id, slug, section_key, injected_at, bytes, pruned_at,
              frozen_card_bytes
       FROM memory_v3_injected_sections ORDER BY conversation_id, slug, section_key`,
    )
    .all() as Row[];
}

function objectNames(db: Database, type: "table" | "index"): string[] {
  return (
    db
      .query(`SELECT name FROM sqlite_master WHERE type = ?`)
      .all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}

let memorySqlite: Database;

/** The superseded card-grain table exactly as migration 345 left it on the
 *  memory connection (frozen; nothing writes it), the copy's source. */
function createLegacyCardsTable(db: Database): void {
  db.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_ever_injected (
      conversation_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      injected_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      pruned_at INTEGER,
      PRIMARY KEY (conversation_id, slug)
    )
  `);
}

beforeEach(() => {
  memorySqlite = new Database(":memory:");
});

describe("ensureMemoryV3InjectedSectionsSchema", () => {
  test("creates the table and its conversation index when no legacy table exists", () => {
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    expect(objectNames(memorySqlite, "table")).toContain(
      "memory_v3_injected_sections",
    );
    expect(objectNames(memorySqlite, "index")).toContain(
      "idx_memory_v3_injected_sections_conv",
    );
    expect(rows(memorySqlite)).toEqual([]);
  });

  test("copies every legacy card row as that page's lead entry, fields preserved", () => {
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, 3000),
        ('conv-2', 'topics/page-a', 4000, 0, NULL)
    `);

    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    expect(rows(memorySqlite)).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 1000,
        bytes: 120,
        pruned_at: null,
        frozen_card_bytes: 120,
      },
      {
        conversation_id: "conv-1",
        slug: "topics/page-b",
        section_key: "",
        injected_at: 2000,
        bytes: 340,
        pruned_at: 3000,
        frozen_card_bytes: 340,
      },
      {
        conversation_id: "conv-2",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 4000,
        bytes: 0,
        pruned_at: null,
        frozen_card_bytes: 0,
      },
    ]);
    // The legacy table is left in place, untouched.
    expect(objectNames(memorySqlite, "table")).toContain(
      "memory_v3_ever_injected",
    );
  });

  test("re-running neither duplicates rows nor overwrites entries refreshed since", () => {
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, 5000)
    `);
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);
    // The section store re-injects the lead after the copy: pruned_at clears.
    memorySqlite.exec(/*sql*/ `
      UPDATE memory_v3_injected_sections
      SET injected_at = 9000, bytes = 150, pruned_at = NULL
      WHERE conversation_id = 'conv-1' AND slug = 'topics/page-a'
    `);

    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    expect(rows(memorySqlite)).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 9000,
        bytes: 150,
        pruned_at: null,
        // The frozen length is the card's, whatever the row's bytes became.
        frozen_card_bytes: 120,
      },
    ]);
  });

  test("adds frozen_card_bytes to a table created without it and backfills copied rows from the legacy table", () => {
    memorySqlite.exec(/*sql*/ `
      CREATE TABLE memory_v3_injected_sections (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        section_key TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER,
        PRIMARY KEY (conversation_id, slug, section_key)
      );
      INSERT INTO memory_v3_injected_sections
        (conversation_id, slug, section_key, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', '', 9000, 150, NULL),
        ('conv-1', 'topics/page-a', 'Notes', 9100, 60, NULL),
        ('conv-1', 'fresh-page', '', 9200, 80, NULL)
    `);
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    ensureMemoryV3InjectedSectionsSchema(memorySqlite);
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    // The copied lead keeps the row the store refreshed but gains the card's
    // length; a section row and a page the legacy table never had stay null.
    expect(
      rows(memorySqlite).map((row) => [
        `${row.slug} ${row.section_key}`,
        row.bytes,
        row.frozen_card_bytes,
      ]),
    ).toEqual([
      ["fresh-page ", 80, null],
      ["topics/page-a ", 150, 120],
      ["topics/page-a Notes", 60, null],
    ]);
  });

  test("a legacy table that appears after the first ensure is copied by the next one", () => {
    ensureMemoryV3InjectedSectionsSchema(memorySqlite);
    expect(rows(memorySqlite)).toEqual([]);
    createLegacyCardsTable(memorySqlite);
    memorySqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    ensureMemoryV3InjectedSectionsSchema(memorySqlite);

    expect(
      rows(memorySqlite).map((row) => [row.slug, row.frozen_card_bytes]),
    ).toEqual([["topics/page-a", 120]]);
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
