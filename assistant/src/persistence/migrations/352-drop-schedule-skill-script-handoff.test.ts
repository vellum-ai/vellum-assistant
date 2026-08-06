import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateScheduleSkillScriptHandoff } from "./351-schedule-skill-script-handoff.js";
import { migrateDropScheduleSkillScriptHandoff } from "./352-drop-schedule-skill-script-handoff.js";

/** Minimal `cron_jobs`, trimmed to what these two migrations touch. */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(cron_jobs)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

const REVERTED = ["then_execute", "skill_id", "skill_version_hash"];

describe("migration 352 — drop reverted schedule columns", () => {
  test("removes the columns 351 added", () => {
    const { sqlite, db } = createTestDb();

    migrateScheduleSkillScriptHandoff(db);
    for (const column of REVERTED) {
      expect(columnNames(sqlite)).toContain(column);
    }

    migrateDropScheduleSkillScriptHandoff(db);
    for (const column of REVERTED) {
      expect(columnNames(sqlite)).not.toContain(column);
    }
  });

  test("leaves the surrounding columns intact", () => {
    const { sqlite, db } = createTestDb();
    const before = columnNames(sqlite);

    migrateScheduleSkillScriptHandoff(db);
    migrateDropScheduleSkillScriptHandoff(db);

    // 351 + 352 net to nothing: the pair exists only so the already-recorded
    // 351 can stay in the ledger.
    expect(columnNames(sqlite)).toEqual(before);
  });

  test("is a no-op on a database that never ran 351", () => {
    const { sqlite, db } = createTestDb();
    const before = columnNames(sqlite);

    expect(() => migrateDropScheduleSkillScriptHandoff(db)).not.toThrow();
    expect(columnNames(sqlite)).toEqual(before);
  });

  test("is idempotent when re-run after a partial application", () => {
    const { sqlite, db } = createTestDb();
    migrateScheduleSkillScriptHandoff(db);
    // Simulate a crash between column drops.
    sqlite.exec("ALTER TABLE cron_jobs DROP COLUMN skill_id");

    expect(() => migrateDropScheduleSkillScriptHandoff(db)).not.toThrow();
    for (const column of REVERTED) {
      expect(columnNames(sqlite)).not.toContain(column);
    }
  });
});
