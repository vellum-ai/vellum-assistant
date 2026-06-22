import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateToolInvocationsCreatedAtIdIndex } from "./276-tool-invocations-created-at-id-index.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-276 shape: no (created_at, id) index.
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
      skill_id TEXT,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function indexNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA index_list(tool_invocations)").all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 276: tool_invocations (created_at, id) index", () => {
  test("creates the index on (created_at, id)", () => {
    const { sqlite, db } = createTestDb();
    expect(indexNames(sqlite)).not.toContain(
      "idx_tool_invocations_created_at_id",
    );

    migrateToolInvocationsCreatedAtIdIndex(db);

    expect(indexNames(sqlite)).toContain("idx_tool_invocations_created_at_id");
    const columns = (
      sqlite
        .query("PRAGMA index_info(idx_tool_invocations_created_at_id)")
        .all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["created_at", "id"]);
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateToolInvocationsCreatedAtIdIndex(db);
    expect(() => migrateToolInvocationsCreatedAtIdIndex(db)).not.toThrow();

    expect(
      indexNames(sqlite).filter(
        (name) => name === "idx_tool_invocations_created_at_id",
      ),
    ).toHaveLength(1);
  });
});
