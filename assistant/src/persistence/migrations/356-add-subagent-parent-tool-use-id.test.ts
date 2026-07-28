import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddSubagentParentToolUseId } from "./356-add-subagent-parent-tool-use-id.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-354 shape: only the columns the migration and tests touch.
  sqlite.exec(/*sql*/ `
    CREATE TABLE subagents (
      id TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(subagents)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function toolUseIdOf(sqlite: Database, id: string): unknown {
  const row = sqlite
    .query("SELECT parent_tool_use_id FROM subagents WHERE id = ?")
    .get(id) as { parent_tool_use_id: unknown };
  return row.parent_tool_use_id;
}

describe("migration 354: subagents.parent_tool_use_id", () => {
  test("adds the nullable column", () => {
    const { sqlite, db } = createTestDb();
    expect(columnInfo(sqlite).map((c) => c.name)).not.toContain(
      "parent_tool_use_id",
    );

    migrateAddSubagentParentToolUseId(db);

    const column = columnInfo(sqlite).find(
      (c) => c.name === "parent_tool_use_id",
    );
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("rows written before the column existed read back null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO subagents (id, parent_conversation_id, conversation_id, created_at)
      VALUES ('sub-old', 'parent-1', 'conv-1', 1000)
    `);

    migrateAddSubagentParentToolUseId(db);

    expect(toolUseIdOf(sqlite, "sub-old")).toBeNull();
  });

  test("round-trips an insert that sets the new column", () => {
    const { sqlite, db } = createTestDb();
    migrateAddSubagentParentToolUseId(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO subagents (id, parent_conversation_id, conversation_id, created_at, parent_tool_use_id)
      VALUES ('sub-new', 'parent-1', 'conv-2', 2000, 'toolu-abc')
    `);

    expect(toolUseIdOf(sqlite, "sub-new")).toBe("toolu-abc");
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAddSubagentParentToolUseId(db);
    expect(() => migrateAddSubagentParentToolUseId(db)).not.toThrow();

    const names = columnInfo(sqlite).map((c) => c.name);
    expect(names.filter((n) => n === "parent_tool_use_id")).toHaveLength(1);
  });
});
