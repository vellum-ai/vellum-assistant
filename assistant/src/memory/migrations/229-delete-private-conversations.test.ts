import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../db-connection.js";
import * as schema from "../schema.js";
import { migrateDeletePrivateConversations } from "./229-delete-private-conversations.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      conversation_type TEXT NOT NULL DEFAULT 'standard',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE tool_invocations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE llm_request_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      response_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE memory_recall_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      enabled INTEGER NOT NULL,
      degraded INTEGER NOT NULL,
      provider TEXT,
      model TEXT,
      degradation_json TEXT,
      semantic_hits INTEGER NOT NULL,
      merged_count INTEGER NOT NULL,
      selected_count INTEGER NOT NULL,
      tier1_count INTEGER NOT NULL,
      tier2_count INTEGER NOT NULL,
      hybrid_search_latency_ms INTEGER NOT NULL,
      sparse_vector_used INTEGER NOT NULL,
      injected_tokens INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      top_candidates_json TEXT NOT NULL,
      injected_text TEXT,
      reason TEXT,
      query_context TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE llm_usage_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      conversation_id TEXT,
      run_id TEXT,
      request_id TEXT,
      actor TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      estimated_cost_usd REAL,
      pricing_status TEXT NOT NULL,
      llm_call_count INTEGER,
      metadata_json TEXT
    );

    CREATE TABLE trace_events (
      event_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      request_id TEXT,
      timestamp_ms INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      summary TEXT NOT NULL,
      attributes_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE memory_segments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE memory_embeddings (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE conversation_graph_memory_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE memory_summaries (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE conversation_starters (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      generation_batch INTEGER NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      card_type TEXT NOT NULL DEFAULT 'chip',
      created_at INTEGER NOT NULL
    );
  `);
}

function seedConversation(raw: Database, id: string, conversationType: string) {
  const now = Date.now();
  raw
    .query(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, conversationType, now, now);
  raw
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, 'user', '[]', ?)`,
    )
    .run(`${id}-message`, id, now);
  raw
    .query(
      `INSERT INTO tool_invocations (
        id,
        conversation_id,
        tool_name,
        input,
        result,
        decision,
        risk_level,
        duration_ms,
        created_at
      ) VALUES (?, ?, 'test_tool', '{}', '{}', 'allow', 'low', 1, ?)`,
    )
    .run(`${id}-tool`, id, now);
  raw
    .query(
      `INSERT INTO llm_request_logs (
        id,
        conversation_id,
        request_payload,
        response_payload,
        created_at
      ) VALUES (?, ?, '{}', '{}', ?)`,
    )
    .run(`${id}-llm`, id, now);
  raw
    .query(
      `INSERT INTO memory_recall_logs (
        id,
        conversation_id,
        message_id,
        enabled,
        degraded,
        semantic_hits,
        merged_count,
        selected_count,
        tier1_count,
        tier2_count,
        hybrid_search_latency_ms,
        sparse_vector_used,
        injected_tokens,
        latency_ms,
        top_candidates_json,
        created_at
      ) VALUES (?, ?, ?, 1, 0, 1, 1, 1, 1, 0, 2, 0, 3, 4, '[]', ?)`,
    )
    .run(`${id}-recall`, id, `${id}-message`, now);
  raw
    .query(
      `INSERT INTO llm_usage_events (
        id,
        created_at,
        conversation_id,
        actor,
        provider,
        model,
        input_tokens,
        output_tokens,
        pricing_status
      ) VALUES (?, ?, ?, 'assistant', 'test-provider', 'test-model', 10, 5, 'estimated')`,
    )
    .run(`${id}-usage`, now, id);
  raw
    .query(
      `INSERT INTO trace_events (
        event_id,
        conversation_id,
        timestamp_ms,
        sequence,
        kind,
        summary,
        created_at
      ) VALUES (?, ?, ?, 1, 'llm', 'Test trace event', ?)`,
    )
    .run(`${id}-trace`, id, now, now);
  raw
    .query(
      `INSERT INTO memory_segments (
        id,
        message_id,
        conversation_id,
        role,
        segment_index,
        text,
        token_estimate,
        scope_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'user', 0, 'hello', 1, ?, ?, ?)`,
    )
    .run(
      `${id}-segment`,
      `${id}-message`,
      id,
      `${conversationType}:${id}`,
      now,
      now,
    );
  raw
    .query(
      `INSERT INTO memory_embeddings (
        id,
        target_type,
        target_id,
        provider,
        model,
        dimensions,
        vector_json,
        created_at,
        updated_at
      ) VALUES (?, 'segment', ?, 'test-provider', 'test-model', 3, '[0,0,0]', ?, ?)`,
    )
    .run(`${id}-segment-embedding`, `${id}-segment`, now, now);
  raw
    .query(
      `INSERT INTO attachments (
        id,
        original_filename,
        mime_type,
        size_bytes,
        kind,
        data_base64,
        created_at
      ) VALUES (?, 'example.txt', 'text/plain', 1, 'text', 'eA==', ?)`,
    )
    .run(`${id}-attachment`, now);
  raw
    .query(
      `INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .run(`${id}-message-attachment`, `${id}-message`, `${id}-attachment`, now);
  raw
    .query(
      `INSERT INTO conversation_graph_memory_state (conversation_id, state_json, created_at, updated_at)
       VALUES (?, '{}', ?, ?)`,
    )
    .run(id, now, now);
}

function countWhere(raw: Database, table: string, where: string): number {
  return (
    raw
      .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
      .get() as {
      count: number;
    }
  ).count;
}

describe("migrateDeletePrivateConversations", () => {
  test("deletes private conversations and dependents while preserving other conversation types", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapTables(raw);
    seedConversation(raw, "conv-private", "private");
    seedConversation(raw, "conv-standard", "standard");
    seedConversation(raw, "conv-background", "background");

    raw.exec(/*sql*/ `
      INSERT INTO memory_summaries (id, scope_id, summary, created_at, updated_at)
      VALUES
        ('summary-private', 'private:conv-private', 'removed', ${now}, ${now}),
        ('summary-standard', 'default', 'standard', ${now}, ${now}),
        ('summary-background', 'background:conv-background', 'background', ${now}, ${now});

      INSERT INTO memory_embeddings (
        id,
        target_type,
        target_id,
        provider,
        model,
        dimensions,
        vector_json,
        created_at,
        updated_at
      ) VALUES
        ('summary-private-embedding', 'summary', 'summary-private', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now}),
        ('summary-standard-embedding', 'summary', 'summary-standard', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now}),
        ('summary-background-embedding', 'summary', 'summary-background', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now});

      INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
      VALUES
        ('starter-private', 'Private', 'Private', 1, 'private:conv-private', 'chip', ${now}),
        ('starter-standard', 'Standard', 'Standard', 1, 'default', 'chip', ${now}),
        ('starter-background', 'Background', 'Background', 1, 'background:conv-background', 'chip', ${now});
    `);

    migrateDeletePrivateConversations(db);
    migrateDeletePrivateConversations(db);

    const remainingConversations = raw
      .query(`SELECT id FROM conversations ORDER BY id`)
      .all() as Array<{ id: string }>;
    expect(remainingConversations.map((row) => row.id)).toEqual([
      "conv-background",
      "conv-standard",
    ]);

    for (const { table, column } of [
      { table: "messages", column: "id" },
      { table: "tool_invocations", column: "id" },
      { table: "llm_request_logs", column: "id" },
      { table: "memory_recall_logs", column: "id" },
      { table: "llm_usage_events", column: "id" },
      { table: "trace_events", column: "event_id" },
      { table: "memory_segments", column: "id" },
      { table: "memory_embeddings", column: "id" },
      { table: "message_attachments", column: "id" },
      { table: "conversation_graph_memory_state", column: "conversation_id" },
    ]) {
      expect(countWhere(raw, table, `${column} LIKE 'conv-private%'`)).toBe(0);
      expect(countWhere(raw, table, `${column} LIKE 'conv-standard%'`)).toBe(1);
      expect(countWhere(raw, table, `${column} LIKE 'conv-background%'`)).toBe(
        1,
      );
    }

    expect(
      countWhere(raw, "memory_summaries", `scope_id LIKE 'private:%'`),
    ).toBe(0);
    expect(
      countWhere(raw, "conversation_starters", `scope_id LIKE 'private:%'`),
    ).toBe(0);
    expect(countWhere(raw, "memory_summaries", `scope_id = 'default'`)).toBe(1);
    expect(
      countWhere(raw, "memory_summaries", `scope_id LIKE 'background:%'`),
    ).toBe(1);
    expect(
      countWhere(raw, "memory_embeddings", `id = 'summary-private-embedding'`),
    ).toBe(0);
    expect(
      countWhere(raw, "memory_embeddings", `id = 'summary-standard-embedding'`),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "memory_embeddings",
        `id = 'summary-background-embedding'`,
      ),
    ).toBe(1);
    expect(
      countWhere(raw, "conversation_starters", `scope_id = 'default'`),
    ).toBe(1);
    expect(
      countWhere(raw, "conversation_starters", `scope_id LIKE 'background:%'`),
    ).toBe(1);
  });
});
