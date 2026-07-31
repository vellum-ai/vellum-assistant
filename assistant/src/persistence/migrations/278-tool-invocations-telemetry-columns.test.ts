import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateToolInvocationsTelemetryColumns } from "./278-tool-invocations-telemetry-columns.js";

const NEW_COLUMNS = [
  "arg_bytes",
  "result_bytes",
  "provider",
  "model",
  "inference_profile",
  "inference_profile_source",
];

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-278 shape: skill_id exists (275), telemetry columns do not.
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
      created_at INTEGER NOT NULL,
      skill_id TEXT
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function tableInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(tool_invocations)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

describe("migration 278: tool_invocations telemetry columns", () => {
  test("adds the nullable telemetry columns", () => {
    const { sqlite, db } = createTestDb();
    const before = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(before).not.toContain(name);
    }

    migrateToolInvocationsTelemetryColumns(db);

    const after = tableInfo(sqlite);
    for (const name of NEW_COLUMNS) {
      const column = after.find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    }
  });

  test("existing rows read back with null telemetry columns", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO tool_invocations
        (id, conversation_id, tool_name, input, result, decision, risk_level, duration_ms, created_at)
      VALUES
        ('ti-1', 'conv-1', 'bash', '{}', 'ok', 'allow', 'low', 5, 1000)
    `);

    migrateToolInvocationsTelemetryColumns(db);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM tool_invocations WHERE id = 'ti-1'`,
      )
      .get() as Record<string, unknown>;
    for (const name of NEW_COLUMNS) {
      expect(row[name]).toBeNull();
    }
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateToolInvocationsTelemetryColumns(db);
    expect(() => migrateToolInvocationsTelemetryColumns(db)).not.toThrow();

    const names = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });
});
