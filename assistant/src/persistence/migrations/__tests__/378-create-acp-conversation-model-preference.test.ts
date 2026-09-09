/**
 * Migration 378 creates `acp_conversation_model_preference`, the record of
 * which model a conversation's next run on an agent starts on. Its composite
 * primary key is what makes an explicit choice replace the previous one per
 * agent rather than accumulate, and its conversation column cascades so a
 * preference never outlives the conversation it was chosen for.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateAcpConversationModelPreference } from "../378-create-acp-conversation-model-preference.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function tableNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migrateCreateAcpConversationModelPreference", () => {
  test("creates the table", () => {
    const db = createTestDb();

    migrateCreateAcpConversationModelPreference(db);

    expect(tableNames(db)).toContain("acp_conversation_model_preference");
  });

  test("the conversation column cascades", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY)");
    migrateCreateAcpConversationModelPreference(db);
    raw.exec("INSERT INTO conversations (id) VALUES ('conv-1')");
    raw.exec(
      `INSERT INTO acp_conversation_model_preference
         (parent_conversation_id, agent_id, model, updated_at)
       VALUES ('conv-1', 'claude', 'opus', 10)`,
    );

    raw.exec("DELETE FROM conversations WHERE id = 'conv-1'");

    const count = raw
      .prepare("SELECT COUNT(*) AS n FROM acp_conversation_model_preference")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("re-running preserves existing rows", () => {
    const db = createTestDb();
    migrateCreateAcpConversationModelPreference(db);
    const raw = getSqliteFrom(db);
    raw.exec(
      `INSERT INTO acp_conversation_model_preference
         (parent_conversation_id, agent_id, model, updated_at)
       VALUES ('conv-1', 'claude', 'opus', 10)`,
    );

    migrateCreateAcpConversationModelPreference(db);

    const rows = raw
      .prepare(
        "SELECT parent_conversation_id, agent_id, model FROM acp_conversation_model_preference",
      )
      .all();
    expect(rows).toEqual([
      { parent_conversation_id: "conv-1", agent_id: "claude", model: "opus" },
    ]);
  });

  test("keys on the conversation and agent together", () => {
    const db = createTestDb();
    migrateCreateAcpConversationModelPreference(db);
    const raw = getSqliteFrom(db);

    raw.exec(
      `INSERT INTO acp_conversation_model_preference
         (parent_conversation_id, agent_id, model, updated_at)
       VALUES ('conv-1', 'claude', 'opus', 10)`,
    );
    // A second agent in the same conversation is a separate preference.
    raw.exec(
      `INSERT INTO acp_conversation_model_preference
         (parent_conversation_id, agent_id, model, updated_at)
       VALUES ('conv-1', 'codex', 'gpt-5', 11)`,
    );
    // The same pair replaces rather than accumulates.
    raw.exec(
      `INSERT OR REPLACE INTO acp_conversation_model_preference
         (parent_conversation_id, agent_id, model, updated_at)
       VALUES ('conv-1', 'claude', 'sonnet', 12)`,
    );

    const rows = raw
      .prepare(
        `SELECT agent_id, model FROM acp_conversation_model_preference
         ORDER BY agent_id`,
      )
      .all();
    expect(rows).toEqual([
      { agent_id: "claude", model: "sonnet" },
      { agent_id: "codex", model: "gpt-5" },
    ]);
  });
});
