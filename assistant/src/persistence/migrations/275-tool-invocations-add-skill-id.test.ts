import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateToolInvocationsSkillId } from "./275-tool-invocations-add-skill-id.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-275 shape: no skill_id column.
  sqlite.exec(/*sql*/ `
    CREATE TABLE tool_invocations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      matched_trust_rule_id TEXT,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(tool_invocations)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

describe("migration 275: tool_invocations skill_id", () => {
  test("adds a nullable skill_id column", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain("skill_id");

    migrateToolInvocationsSkillId(db);

    const column = (
      sqlite.query("PRAGMA table_info(tool_invocations)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === "skill_id");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("existing rows read back with skill_id null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO tool_invocations
        (id, conversation_id, tool_name, input, result, decision, risk_level, duration_ms, created_at)
      VALUES
        ('ti-1', 'conv-1', 'bash', '{}', 'ok', 'allow', 'low', 5, 1000)
    `);

    migrateToolInvocationsSkillId(db);

    const row = sqlite
      .query("SELECT skill_id FROM tool_invocations WHERE id = 'ti-1'")
      .get() as { skill_id: string | null };
    expect(row.skill_id).toBeNull();
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateToolInvocationsSkillId(db);
    expect(() => migrateToolInvocationsSkillId(db)).not.toThrow();

    expect(
      columnNames(sqlite).filter((name) => name === "skill_id"),
    ).toHaveLength(1);
  });
});
