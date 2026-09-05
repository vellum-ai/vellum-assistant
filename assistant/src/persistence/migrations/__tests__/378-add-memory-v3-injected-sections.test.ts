/**
 * Migration 378 creates memory-v3's section-grain injection record
 * (`memory_v3_injected_sections`) on the memory connection and seeds it from
 * the card-grain `memory_v3_ever_injected`, one lead entry per legacy row.
 *
 * `mock.module` is process-global, so the db-connection stub delegates to the
 * real implementation unless this file's tests are running.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { ensureMemoryV3EverInjectedSchema } from "../345-move-memory-v3-ever-injected-to-memory-db.js";

const realDb = { ...(await import("../../db-connection.js")) };

let migrationMockActive = false;
let memorySqlite: Database | null = null;

mock.module("../../db-connection.js", () => ({
  ...realDb,
  getMemorySqlite: () =>
    migrationMockActive ? memorySqlite : realDb.getMemorySqlite(),
}));

const {
  ensureMemoryV3InjectedSectionsSchema,
  migrateAddMemoryV3InjectedSections,
} = await import("../378-add-memory-v3-injected-sections.js");

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

beforeEach(() => {
  migrationMockActive = true;
  memorySqlite = new Database(":memory:");
});

afterAll(() => {
  migrationMockActive = false;
});

describe("migrateAddMemoryV3InjectedSections", () => {
  test("creates the table and its conversation index when no legacy table exists", () => {
    migrateAddMemoryV3InjectedSections({} as never);

    expect(objectNames(memorySqlite!, "table")).toContain(
      "memory_v3_injected_sections",
    );
    expect(objectNames(memorySqlite!, "index")).toContain(
      "idx_memory_v3_injected_sections_conv",
    );
    expect(rows(memorySqlite!)).toEqual([]);
  });

  test("copies every legacy card row as that page's lead entry, fields preserved", () => {
    ensureMemoryV3EverInjectedSchema(memorySqlite!);
    memorySqlite!.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, 3000),
        ('conv-2', 'topics/page-a', 4000, 0, NULL)
    `);

    migrateAddMemoryV3InjectedSections({} as never);

    expect(rows(memorySqlite!)).toEqual([
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
    expect(objectNames(memorySqlite!, "table")).toContain(
      "memory_v3_ever_injected",
    );
  });

  test("re-running neither duplicates rows nor overwrites entries refreshed since", () => {
    ensureMemoryV3EverInjectedSchema(memorySqlite!);
    memorySqlite!.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, 5000)
    `);
    migrateAddMemoryV3InjectedSections({} as never);
    // The section store re-injects the lead after the copy: pruned_at clears.
    memorySqlite!.exec(/*sql*/ `
      UPDATE memory_v3_injected_sections
      SET injected_at = 9000, bytes = 150, pruned_at = NULL
      WHERE conversation_id = 'conv-1' AND slug = 'topics/page-a'
    `);

    migrateAddMemoryV3InjectedSections({} as never);

    expect(rows(memorySqlite!)).toEqual([
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
    memorySqlite!.exec(/*sql*/ `
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
    ensureMemoryV3EverInjectedSchema(memorySqlite!);
    memorySqlite!.exec(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    migrateAddMemoryV3InjectedSections({} as never);
    migrateAddMemoryV3InjectedSections({} as never);

    // The copied lead keeps the row the store refreshed but gains the card's
    // length; a section row and a page the legacy table never had stay null.
    expect(
      rows(memorySqlite!).map((row) => [
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

  test("ensure is idempotent on its own", () => {
    ensureMemoryV3InjectedSectionsSchema(memorySqlite!);
    ensureMemoryV3InjectedSectionsSchema(memorySqlite!);
    expect(objectNames(memorySqlite!, "table")).toContain(
      "memory_v3_injected_sections",
    );
  });

  test("throws when the memory database is unavailable so the step is retried", () => {
    memorySqlite = null;
    expect(() => migrateAddMemoryV3InjectedSections({} as never)).toThrow(
      /memory database unavailable/,
    );
  });
});
