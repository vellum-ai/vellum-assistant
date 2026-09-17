import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateCreateConversationToolSurfaces } from "./378-create-conversation-tool-surfaces.js";
import { migrateConversationToolSurfacesDelegateIndependentTasks } from "./380-conversation-tool-surfaces-delegate-independent-tasks.js";

function createTestDb(options: { withTable?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  // Only the parent table the FK points at.
  sqlite.run(/*sql*/ `CREATE TABLE conversations (id TEXT PRIMARY KEY)`);
  const db = drizzle(sqlite, { schema });
  if (options.withTable !== false) {
    // Pre-380 shape: the table as migration 378 creates it.
    migrateCreateConversationToolSurfaces(db);
  }
  return { sqlite, db };
}

function columns(sqlite: Database): Array<{ name: string; notnull: number }> {
  return sqlite
    .query("PRAGMA table_info(conversation_tool_surfaces)")
    .all() as Array<{ name: string; notnull: number }>;
}

describe("migration 380: conversation_tool_surfaces.delegate_independent_tasks", () => {
  test("adds the nullable column", () => {
    const { sqlite, db } = createTestDb();
    expect(columns(sqlite).map((c) => c.name)).not.toContain(
      "delegate_independent_tasks",
    );

    migrateConversationToolSurfacesDelegateIndependentTasks(db);

    const column = columns(sqlite).find(
      (c) => c.name === "delegate_independent_tasks",
    );
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("rows written before the column existed read back null", () => {
    // A fork replaying such a row derives the section for itself, which is
    // what it did before the column existed.
    const { sqlite, db } = createTestDb();
    sqlite.query(`INSERT INTO conversations (id) VALUES (?)`).run("conv-1");
    sqlite
      .query(
        /*sql*/ `INSERT INTO conversation_tool_surfaces (conversation_id, tools_json, tools_hash, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run("conv-1", "[]", "hash", 1);

    migrateConversationToolSurfacesDelegateIndependentTasks(db);

    const row = sqlite
      .query(
        "SELECT delegate_independent_tasks FROM conversation_tool_surfaces WHERE conversation_id = 'conv-1'",
      )
      .get() as { delegate_independent_tasks: unknown };
    expect(row.delegate_independent_tasks).toBeNull();
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateConversationToolSurfacesDelegateIndependentTasks(db);
    expect(() =>
      migrateConversationToolSurfacesDelegateIndependentTasks(db),
    ).not.toThrow();

    expect(
      columns(sqlite).filter((c) => c.name === "delegate_independent_tasks"),
    ).toHaveLength(1);
  });

  test("a missing table is a failure, never a silent success", () => {
    // The runner checkpoints a throwing step as failed and retries it, and
    // the registry defers this step behind the table's own. Swallowing the
    // error here would checkpoint the step as done against no table, and the
    // column would never be added.
    const { db } = createTestDb({ withTable: false });

    expect(() =>
      migrateConversationToolSurfacesDelegateIndependentTasks(db),
    ).toThrow();
  });
});
