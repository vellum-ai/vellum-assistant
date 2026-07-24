import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddLlmUsageConversationSource } from "./354-add-llm-usage-conversation-source.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-354 shape: only the columns the migration and tests touch.
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE llm_usage_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      conversation_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      pricing_status TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertConversation(
  sqlite: Database,
  id: string,
  source: string,
): void {
  sqlite.run(
    `INSERT INTO conversations (id, source, created_at, updated_at) VALUES (?, ?, 1000, 1000)`,
    [id, source],
  );
}

function insertUsageEvent(
  sqlite: Database,
  id: string,
  conversationId: string | null,
): void {
  sqlite.run(
    `INSERT INTO llm_usage_events (id, created_at, conversation_id, provider, model, input_tokens, output_tokens, pricing_status)
     VALUES (?, 1000, ?, 'anthropic', 'test-model', 1, 1, 'priced')`,
    [id, conversationId],
  );
}

function sourceOf(sqlite: Database, eventId: string): unknown {
  const row = sqlite
    .query("SELECT conversation_source FROM llm_usage_events WHERE id = ?")
    .get(eventId) as { conversation_source: unknown };
  return row.conversation_source;
}

describe("migration 354: llm_usage_events.conversation_source", () => {
  test("adds the nullable column", () => {
    const { sqlite, db } = createTestDb();
    migrateAddLlmUsageConversationSource(db);

    const columns = (
      sqlite.query("PRAGMA table_info(llm_usage_events)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).filter((c) => c.name === "conversation_source");
    expect(columns).toHaveLength(1);
    expect(columns[0].notnull).toBe(0);
  });

  test("backfills existing rows from surviving parent conversations", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-retro", "memory-retrospective");
    insertUsageEvent(sqlite, "evt-live-parent", "conv-retro");
    // Parent already deleted before the upgrade — unrecoverable, stays NULL.
    insertUsageEvent(sqlite, "evt-gone-parent", "conv-gone");
    insertUsageEvent(sqlite, "evt-no-parent", null);

    migrateAddLlmUsageConversationSource(db);

    expect(sourceOf(sqlite, "evt-live-parent")).toBe("memory-retrospective");
    expect(sourceOf(sqlite, "evt-gone-parent")).toBeNull();
    expect(sourceOf(sqlite, "evt-no-parent")).toBeNull();
  });

  test("re-run never overwrites existing stamps", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-user", "user");
    insertUsageEvent(sqlite, "evt-1", "conv-user");

    migrateAddLlmUsageConversationSource(db);
    expect(sourceOf(sqlite, "evt-1")).toBe("user");

    // Simulate the parent's source having been recorded differently than the
    // row now joined (the stamp is the record-time truth): a re-run must
    // fill only NULLs and leave existing values alone.
    sqlite.run(
      `UPDATE llm_usage_events SET conversation_source = 'subagent' WHERE id = 'evt-1'`,
    );
    migrateAddLlmUsageConversationSource(db);
    expect(sourceOf(sqlite, "evt-1")).toBe("subagent");
  });
});
