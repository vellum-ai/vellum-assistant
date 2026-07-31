import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { createSkillLoadedEventsTable } from "./279-create-skill-loaded-events.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(skill_loaded_events)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

function indexNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA index_list(skill_loaded_events)").all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 279: skill_loaded_events table", () => {
  test("creates the table with the expected columns", () => {
    const { sqlite, db } = createTestDb();

    createSkillLoadedEventsTable(db);

    expect(columnNames(sqlite)).toEqual([
      "id",
      "created_at",
      "conversation_id",
      "skill_name",
      "skill_updated_at",
      "provider",
      "model",
      "inference_profile",
      "inference_profile_source",
    ]);
  });

  test("creates the (created_at, id) cursor index", () => {
    const { sqlite, db } = createTestDb();

    createSkillLoadedEventsTable(db);

    expect(indexNames(sqlite)).toContain(
      "idx_skill_loaded_events_created_at_id",
    );
    const columns = (
      sqlite
        .query("PRAGMA index_info(idx_skill_loaded_events_created_at_id)")
        .all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["created_at", "id"]);
  });

  test("is idempotent — re-run is a no-op and preserves existing rows", () => {
    const { sqlite, db } = createTestDb();

    createSkillLoadedEventsTable(db);
    sqlite.exec(/*sql*/ `
      INSERT INTO skill_loaded_events (id, created_at, skill_name)
      VALUES ('sle-1', 1000, 'web-research')
    `);

    expect(() => createSkillLoadedEventsTable(db)).not.toThrow();

    const rows = sqlite.query("SELECT id FROM skill_loaded_events").all();
    expect(rows).toEqual([{ id: "sle-1" }]);
    expect(
      indexNames(sqlite).filter(
        (name) => name === "idx_skill_loaded_events_created_at_id",
      ),
    ).toHaveLength(1);
  });
});
