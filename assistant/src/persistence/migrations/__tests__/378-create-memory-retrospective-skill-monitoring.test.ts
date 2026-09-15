import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ensureMemoryRetrospectiveSkillMonitoringSchema } from "../378-create-memory-retrospective-skill-monitoring.js";

function tableColumns(sqlite: Database, table: string): string[] {
  return sqlite
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function indexNames(sqlite: Database, table: string): string[] {
  return sqlite
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all(table)
    .map((row) => row.name);
}

describe("migration 378: retrospective skill monitoring", () => {
  test("creates normalized search, candidate, and change tables", () => {
    const sqlite = new Database(":memory:");
    ensureMemoryRetrospectiveSkillMonitoringSchema(sqlite);

    expect(
      tableColumns(sqlite, "memory_retrospective_skill_searches").sort(),
    ).toEqual(
      [
        "created_at",
        "conversation_id",
        "decided_at",
        "goal",
        "id",
        "outcome",
        "reason",
        "run_conversation_id",
      ].sort(),
    );
    expect(
      tableColumns(sqlite, "memory_retrospective_skill_candidates").sort(),
    ).toEqual(
      [
        "consideration_status",
        "created_at",
        "conversation_id",
        "decided_at",
        "decision",
        "id",
        "rank",
        "reason",
        "run_conversation_id",
        "score",
        "search_id",
        "skill_author",
        "skill_description",
        "skill_id",
        "skill_name",
        "skill_source",
        "system_exclusion_reason",
      ].sort(),
    );
    expect(
      tableColumns(sqlite, "memory_retrospective_skill_changes").sort(),
    ).toEqual(
      [
        "created_at",
        "conversation_id",
        "delta",
        "id",
        "operation",
        "run_conversation_id",
        "search_id",
        "skill_id",
      ].sort(),
    );
    expect(
      indexNames(sqlite, "memory_retrospective_skill_candidates"),
    ).toContain("idx_memory_retro_skill_candidates_search_skill");
    sqlite.close();
  });

  test("is idempotent and keeps one candidate per search and skill", () => {
    const sqlite = new Database(":memory:");
    ensureMemoryRetrospectiveSkillMonitoringSchema(sqlite);
    ensureMemoryRetrospectiveSkillMonitoringSchema(sqlite);
    const insert = sqlite.query(`
      INSERT INTO memory_retrospective_skill_candidates (
        id, search_id, conversation_id, run_conversation_id, skill_id,
        skill_name, skill_description, skill_source, consideration_status,
        rank, score, created_at
      ) VALUES (?, 'search-1', 'conv-1', 'run-1', 'skill-1',
                'Skill One', 'Description', 'managed', 'surfaced', 1, 0.9, 1)
    `);
    insert.run("candidate-1");
    expect(() => insert.run("candidate-2")).toThrow();
    sqlite.close();
  });
});
