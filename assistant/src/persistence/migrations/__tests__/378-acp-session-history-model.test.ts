/**
 * Migration 378 adds the nullable `model` column that records which model a
 * finished ACP run was on, and is idempotent so a repair flow can re-run it.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateAcpSessionHistoryModel } from "../378-acp-session-history-model.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec(
    "CREATE TABLE acp_session_history (id TEXT PRIMARY KEY, status TEXT)",
  );
  return drizzle(sqlite, { schema });
}

function columnNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("PRAGMA table_info(acp_session_history)")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migrateAcpSessionHistoryModel", () => {
  test("adds the column when it is missing", () => {
    const db = createTestDb();

    migrateAcpSessionHistoryModel(db);

    expect(columnNames(db)).toContain("model");
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateAcpSessionHistoryModel(db);
    migrateAcpSessionHistoryModel(db);

    expect(columnNames(db)).toContain("model");
  });

  test("preserves existing rows, leaving their model unknown", () => {
    // A run that finished before the column existed reported no model. Null
    // says exactly that, which is what keeps a detail panel from claiming a
    // model the run may never have been on.
    const db = createTestDb();
    getSqliteFrom(db).exec(
      "INSERT INTO acp_session_history (id, status) VALUES ('run-1', 'completed')",
    );

    migrateAcpSessionHistoryModel(db);

    const row = getSqliteFrom(db)
      .prepare(
        "SELECT status, model FROM acp_session_history WHERE id = 'run-1'",
      )
      .get() as { status: string; model: string | null };
    expect(row).toEqual({ status: "completed", model: null });
  });
});
