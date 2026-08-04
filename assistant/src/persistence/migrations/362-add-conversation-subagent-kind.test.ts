import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddConversationSubagentKind } from "./362-add-conversation-subagent-kind.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-360 shape: only the columns the migration and tests touch. The
  // `subagents` table (migration 311) always precedes 360 in the step order
  // and is the backfill source.
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE subagents (
      id TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      is_fork INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function kindOf(
  sqlite: Database,
  conversationId: string,
): { role: unknown; mode: unknown } {
  const row = sqlite
    .query(
      "SELECT subagent_role, subagent_spawn_mode FROM conversations WHERE id = ?",
    )
    .get(conversationId) as {
    subagent_role: unknown;
    subagent_spawn_mode: unknown;
  };
  return { role: row.subagent_role, mode: row.subagent_spawn_mode };
}

function columnInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

describe("migration 362: conversations subagent role / spawn mode", () => {
  test("adds both columns, nullable", () => {
    const { sqlite, db } = createTestDb();
    const before = columnInfo(sqlite).map((c) => c.name);
    expect(before).not.toContain("subagent_role");
    expect(before).not.toContain("subagent_spawn_mode");

    migrateAddConversationSubagentKind(db);

    for (const name of ["subagent_role", "subagent_spawn_mode"]) {
      const column = columnInfo(sqlite).find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    }
  });

  test("existing non-subagent rows read back null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES ('conv-1', 1000, 1000)
    `);

    migrateAddConversationSubagentKind(db);

    expect(kindOf(sqlite, "conv-1")).toEqual({ role: null, mode: null });
  });

  test("round-trips an insert that sets the new columns", () => {
    const { sqlite, db } = createTestDb();
    migrateAddConversationSubagentKind(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at, subagent_role, subagent_spawn_mode)
      VALUES ('child-1', 2000, 2000, 'researcher', 'regular')
    `);

    expect(kindOf(sqlite, "child-1")).toEqual({
      role: "researcher",
      mode: "regular",
    });
  });

  test("backfills role and derives spawn mode from surviving subagents rows", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at) VALUES
        ('sub-regular', 1000, 1000),
        ('sub-fork', 2000, 2000),
        ('sub-advisor', 3000, 3000),
        ('plain-conv', 4000, 4000);
      INSERT INTO subagents (id, parent_conversation_id, conversation_id, role, is_fork) VALUES
        ('s1', 'parent-a', 'sub-regular', 'coder', 0),
        ('s2', 'parent-b', 'sub-fork', 'general', 1),
        ('s3', 'parent-c', 'sub-advisor', 'advisor', 1);
    `);

    migrateAddConversationSubagentKind(db);

    expect(kindOf(sqlite, "sub-regular")).toEqual({
      role: "coder",
      mode: "regular",
    });
    expect(kindOf(sqlite, "sub-fork")).toEqual({
      role: "general",
      mode: "fork",
    });
    // The advisor is a role, so the derived mode must be `advisor_consult`
    // rather than the bare `fork` its `is_fork` flag would otherwise imply.
    expect(kindOf(sqlite, "sub-advisor")).toEqual({
      role: "advisor",
      mode: "advisor_consult",
    });
    // Conversations with no surviving subagents row stay unattributed.
    expect(kindOf(sqlite, "plain-conv")).toEqual({ role: null, mode: null });
  });

  test("backfill does not overwrite already-stamped values", () => {
    const { sqlite, db } = createTestDb();
    migrateAddConversationSubagentKind(db);
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at, subagent_role, subagent_spawn_mode)
      VALUES ('stamped', 1000, 1000, 'general', 'voice_continuation');
      INSERT INTO subagents (id, parent_conversation_id, conversation_id, role, is_fork)
      VALUES ('s1', 'parent-stale', 'stamped', 'general', 1);
    `);

    migrateAddConversationSubagentKind(db);

    expect(kindOf(sqlite, "stamped")).toEqual({
      role: "general",
      mode: "voice_continuation",
    });
  });

  test("indexes subagents.conversation_id so the backfill is not quadratic", () => {
    const { sqlite, db } = createTestDb();

    migrateAddConversationSubagentKind(db);

    const indexes = (
      sqlite.query("PRAGMA index_list(subagents)").all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_subagents_conversation_id");

    // Both backfill statements look `subagents` up once per `conversations`
    // row. Without the index that lookup is a full scan of `subagents`, which
    // makes a step that blocks daemon startup quadratic.
    const plan = (
      sqlite
        .query(
          "EXPLAIN QUERY PLAN SELECT 1 FROM subagents s WHERE s.conversation_id = 'c1'",
        )
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("idx_subagents_conversation_id");
    expect(plan).not.toContain("SCAN");
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAddConversationSubagentKind(db);
    expect(() => migrateAddConversationSubagentKind(db)).not.toThrow();

    const names = columnInfo(sqlite).map((c) => c.name);
    expect(names.filter((n) => n === "subagent_role")).toHaveLength(1);
    expect(names.filter((n) => n === "subagent_spawn_mode")).toHaveLength(1);
  });
});
