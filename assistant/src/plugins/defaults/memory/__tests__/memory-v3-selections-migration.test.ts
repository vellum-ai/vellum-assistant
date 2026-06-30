import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../../../persistence/db-connection.js";
import { migrateAddMemoryV3Selections } from "../../../../persistence/migrations/268-add-memory-v3-selections.js";
import * as schema from "../../../../persistence/schema/index.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexRow {
  name: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

describe("memory_v3_selections migration", () => {
  test("creates table with expected columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateAddMemoryV3Selections(db);

    const columns = raw
      .query(`PRAGMA table_info(memory_v3_selections)`)
      .all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get("conversation_id")?.type).toBe("TEXT");
    expect(byName.get("conversation_id")?.notnull).toBe(1);
    expect(byName.get("conversation_id")?.pk).toBe(1);

    expect(byName.get("turn")?.type).toBe("INTEGER");
    expect(byName.get("turn")?.notnull).toBe(1);
    expect(byName.get("turn")?.pk).toBe(2);

    expect(byName.get("slug")?.type).toBe("TEXT");
    expect(byName.get("slug")?.notnull).toBe(1);
    expect(byName.get("slug")?.pk).toBe(3);

    expect(byName.get("source")?.type).toBe("TEXT");
    expect(byName.get("source")?.notnull).toBe(1);

    expect(byName.get("pinned")?.type).toBe("INTEGER");
    expect(byName.get("pinned")?.notnull).toBe(1);
    expect(byName.get("pinned")?.dflt_value).toBe("0");

    expect(byName.get("created_at")?.type).toBe("INTEGER");
    expect(byName.get("created_at")?.notnull).toBe(1);
  });

  test("creates the conversation-turn index", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateAddMemoryV3Selections(db);

    const indexes = raw
      .query(`PRAGMA index_list(memory_v3_selections)`)
      .all() as IndexRow[];
    const indexNames = new Set(indexes.map((i) => i.name));

    expect(indexNames.has("idx_memory_v3_selections_conv")).toBe(true);
  });

  test("is idempotent — re-running does not throw and preserves rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateAddMemoryV3Selections(db);

    raw
      .query(
        /*sql*/ `
        INSERT INTO memory_v3_selections (
          conversation_id, turn, slug, source, pinned, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run("conv-abc", 3, "page-slug", "lane-a", 1, 1000);

    expect(() => migrateAddMemoryV3Selections(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT slug FROM memory_v3_selections WHERE conversation_id = 'conv-abc' AND turn = 3`,
      )
      .get() as { slug: string } | null;
    expect(row?.slug).toBe("page-slug");
  });
});
