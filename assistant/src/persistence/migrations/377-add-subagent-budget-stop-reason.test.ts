import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddSubagentBudgetStopReason } from "./377-add-subagent-budget-stop-reason.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-377 shape: only the columns the migration and tests touch.
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

function reasonOf(sqlite: Database, id: string): unknown {
  const row = sqlite
    .query("SELECT budget_stop_reason FROM subagents WHERE id = ?")
    .get(id) as { budget_stop_reason: unknown };
  return row.budget_stop_reason;
}

describe("migration 377: subagents.budget_stop_reason", () => {
  test("adds the nullable column", () => {
    const { sqlite, db } = createTestDb();
    expect(columnInfo(sqlite).map((c) => c.name)).not.toContain(
      "budget_stop_reason",
    );

    migrateAddSubagentBudgetStopReason(db);

    const column = columnInfo(sqlite).find(
      (c) => c.name === "budget_stop_reason",
    );
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("rows written before the column existed read back null", () => {
    // Those rows kept no record of why they aborted, so they read as
    // cancellations: the conservative answer for a guard that only advises.
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO subagents (id, parent_conversation_id, conversation_id, status, created_at)
      VALUES ('sub-old', 'parent-1', 'conv-1', 'aborted', 1000)
    `);

    migrateAddSubagentBudgetStopReason(db);

    expect(reasonOf(sqlite, "sub-old")).toBeNull();
  });

  test("round-trips an insert that sets the new column", () => {
    const { sqlite, db } = createTestDb();
    migrateAddSubagentBudgetStopReason(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO subagents (id, parent_conversation_id, conversation_id, status, created_at, budget_stop_reason)
      VALUES ('sub-new', 'parent-1', 'conv-2', 'aborted', 2000, 'ran past its time limit')
    `);

    expect(reasonOf(sqlite, "sub-new")).toBe("ran past its time limit");
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAddSubagentBudgetStopReason(db);
    expect(() => migrateAddSubagentBudgetStopReason(db)).not.toThrow();

    const names = columnInfo(sqlite).map((c) => c.name);
    expect(names.filter((n) => n === "budget_stop_reason")).toHaveLength(1);
  });
});
