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

    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      deferrals INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      last_error TEXT,
      started_at INTEGER,
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

    CREATE TABLE memory_graph_nodes (
      id                    TEXT PRIMARY KEY,
      content               TEXT NOT NULL,
      type                  TEXT NOT NULL,
      created               INTEGER NOT NULL,
      last_accessed         INTEGER NOT NULL,
      last_consolidated     INTEGER NOT NULL,
      emotional_charge      TEXT NOT NULL,
      fidelity              TEXT NOT NULL DEFAULT 'vivid',
      confidence            REAL NOT NULL,
      significance          REAL NOT NULL,
      stability             REAL NOT NULL DEFAULT 14,
      reinforcement_count   INTEGER NOT NULL DEFAULT 0,
      last_reinforced       INTEGER NOT NULL,
      source_conversations  TEXT NOT NULL DEFAULT '[]',
      source_type           TEXT NOT NULL DEFAULT 'inferred',
      narrative_role        TEXT,
      part_of_story         TEXT,
      scope_id              TEXT NOT NULL DEFAULT 'default',
      event_date            INTEGER,
      image_refs            TEXT
    );

    CREATE TABLE memory_graph_edges (
      id              TEXT PRIMARY KEY,
      source_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      target_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      relationship    TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      created         INTEGER NOT NULL
    );

    CREATE TABLE memory_graph_triggers (
      id                   TEXT PRIMARY KEY,
      node_id              TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      type                 TEXT NOT NULL,
      schedule             TEXT,
      condition            TEXT,
      condition_embedding  BLOB,
      threshold            REAL,
      event_date           INTEGER,
      ramp_days            INTEGER,
      follow_up_days       INTEGER,
      recurring            INTEGER NOT NULL DEFAULT 0,
      consumed             INTEGER NOT NULL DEFAULT 0,
      cooldown_ms          INTEGER,
      last_fired           INTEGER
    );

    CREATE TABLE memory_graph_node_edits (
      id                TEXT PRIMARY KEY,
      node_id           TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      previous_content  TEXT NOT NULL,
      new_content       TEXT NOT NULL,
      source            TEXT NOT NULL,
      conversation_id   TEXT,
      created           INTEGER NOT NULL
    );

    CREATE TABLE call_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initiated',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE call_pending_questions (
      id TEXT PRIMARY KEY,
      call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      asked_at INTEGER NOT NULL
    );

    CREATE TABLE guardian_action_requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      pending_question_id TEXT NOT NULL REFERENCES call_pending_questions(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      request_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE guardian_action_deliveries (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES guardian_action_requests(id) ON DELETE CASCADE,
      destination_channel TEXT NOT NULL,
      destination_conversation_id TEXT,
      destination_chat_id TEXT,
      destination_external_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE canonical_guardian_requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_channel TEXT,
      conversation_id TEXT,
      request_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE canonical_guardian_deliveries (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES canonical_guardian_requests(id) ON DELETE CASCADE,
      destination_channel TEXT NOT NULL,
      destination_conversation_id TEXT,
      destination_chat_id TEXT,
      destination_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE scoped_approval_grants (
      id TEXT PRIMARY KEY,
      scope_mode TEXT NOT NULL,
      request_id TEXT,
      tool_name TEXT,
      input_digest TEXT,
      request_channel TEXT NOT NULL,
      decision_channel TEXT NOT NULL,
      execution_channel TEXT,
      conversation_id TEXT,
      call_session_id TEXT,
      requester_external_user_id TEXT,
      guardian_external_user_id TEXT,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by_request_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE channel_guardian_approval_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      request_id TEXT,
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      requester_external_user_id TEXT NOT NULL,
      requester_chat_id TEXT NOT NULL,
      guardian_external_user_id TEXT NOT NULL,
      guardian_chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER NOT NULL,
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

function seedGraphRows(raw: Database, now: number): void {
  raw.exec(/*sql*/ `
    INSERT INTO memory_graph_nodes (
      id,
      content,
      type,
      created,
      last_accessed,
      last_consolidated,
      emotional_charge,
      fidelity,
      confidence,
      significance,
      stability,
      reinforcement_count,
      last_reinforced,
      source_conversations,
      source_type,
      scope_id
    ) VALUES
      ('graph-private-a', 'private a', 'semantic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.8, 14, 0, ${now}, '["conv-private"]', 'inferred', 'private:conv-private'),
      ('graph-private-b', 'private b', 'episodic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.7, 14, 0, ${now}, '["conv-private"]', 'inferred', 'private:other'),
      ('graph-standard', 'standard', 'semantic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.8, 14, 0, ${now}, '["conv-standard"]', 'inferred', 'default'),
      ('graph-background', 'background', 'semantic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.8, 14, 0, ${now}, '["conv-background"]', 'inferred', 'background:conv-background');

    INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relationship, weight, created)
    VALUES
      ('edge-private-source', 'graph-private-a', 'graph-standard', 'reminds-of', 1.0, ${now}),
      ('edge-private-target', 'graph-standard', 'graph-private-b', 'reminds-of', 1.0, ${now}),
      ('edge-standard-background', 'graph-standard', 'graph-background', 'reminds-of', 1.0, ${now});

    INSERT INTO memory_graph_triggers (
      id,
      node_id,
      type,
      schedule,
      condition,
      threshold,
      recurring,
      consumed
    ) VALUES
      ('trigger-private', 'graph-private-a', 'semantic', NULL, 'private condition', 0.8, 0, 0),
      ('trigger-standard', 'graph-standard', 'semantic', NULL, 'standard condition', 0.8, 0, 0),
      ('trigger-background', 'graph-background', 'semantic', NULL, 'background condition', 0.8, 0, 0);

    INSERT INTO memory_graph_node_edits (
      id,
      node_id,
      previous_content,
      new_content,
      source,
      conversation_id,
      created
    ) VALUES
      ('edit-private', 'graph-private-a', 'old private', 'new private', 'manual', 'conv-private', ${now}),
      ('edit-standard', 'graph-standard', 'old standard', 'new standard', 'manual', 'conv-standard', ${now}),
      ('edit-background', 'graph-background', 'old background', 'new background', 'manual', 'conv-background', ${now});

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
      ('graph-private-a-embedding', 'graph_node', 'graph-private-a', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now}),
      ('graph-private-b-embedding', 'graph_node', 'graph-private-b', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now}),
      ('graph-standard-embedding', 'graph_node', 'graph-standard', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now}),
      ('graph-background-embedding', 'graph_node', 'graph-background', 'test-provider', 'test-model', 3, '[0,0,0]', ${now}, ${now});

    INSERT INTO memory_jobs (
      id,
      type,
      payload,
      status,
      attempts,
      run_after,
      created_at,
      updated_at
    ) VALUES
      ('job-standard-embed-graph-node', 'embed_graph_node', '{"nodeId":"graph-standard"}', 'pending', 0, ${now}, ${now}, ${now});
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

function seedGuardianAndApprovalRows(raw: Database, now: number): void {
  raw.exec(/*sql*/ `
    INSERT INTO call_sessions (
      id,
      conversation_id,
      provider,
      from_number,
      to_number,
      status,
      created_at,
      updated_at
    ) VALUES
      ('call-standard-guardian', 'conv-standard', 'test-provider', '+15550100', '+15550101', 'initiated', ${now}, ${now}),
      ('call-private-guardian', 'conv-private', 'test-provider', '+15550102', '+15550103', 'initiated', ${now}, ${now});

    INSERT INTO call_pending_questions (
      id,
      call_session_id,
      question_text,
      status,
      asked_at
    ) VALUES
      ('question-standard-guardian', 'call-standard-guardian', 'Approve?', 'pending', ${now});

    INSERT INTO guardian_action_requests (
      id,
      kind,
      source_channel,
      source_conversation_id,
      call_session_id,
      pending_question_id,
      question_text,
      request_code,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES
      ('legacy-request-private-source', 'ask_guardian', 'phone', 'conv-private', 'call-standard-guardian', 'question-standard-guardian', 'Private source?', 'PRIV01', 'pending', ${now + 60000}, ${now}, ${now}),
      ('legacy-request-private-destination', 'ask_guardian', 'phone', 'conv-standard', 'call-standard-guardian', 'question-standard-guardian', 'Private destination?', 'PRIV02', 'pending', ${now + 60000}, ${now}, ${now}),
      ('legacy-request-standard', 'ask_guardian', 'phone', 'conv-standard', 'call-standard-guardian', 'question-standard-guardian', 'Standard?', 'STND01', 'pending', ${now + 60000}, ${now}, ${now});

    INSERT INTO guardian_action_deliveries (
      id,
      request_id,
      destination_channel,
      destination_conversation_id,
      destination_chat_id,
      destination_external_user_id,
      status,
      created_at,
      updated_at
    ) VALUES
      ('legacy-delivery-private-request', 'legacy-request-private-source', 'vellum', 'conv-standard', 'chat-standard', 'user-123', 'pending', ${now}, ${now}),
      ('legacy-delivery-private-destination', 'legacy-request-private-destination', 'vellum', 'conv-private', 'chat-private', 'user-123', 'pending', ${now}, ${now}),
      ('legacy-delivery-standard', 'legacy-request-standard', 'vellum', 'conv-standard', 'chat-standard', 'user-123', 'pending', ${now}, ${now});

    INSERT INTO canonical_guardian_requests (
      id,
      kind,
      source_type,
      source_channel,
      conversation_id,
      request_code,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES
      ('canonical-request-private-source', 'tool_approval', 'conversation', 'vellum', 'conv-private', 'CANP01', 'pending', ${now + 60000}, ${now}, ${now}),
      ('canonical-request-private-destination', 'tool_approval', 'conversation', 'vellum', 'conv-standard', 'CANP02', 'pending', ${now + 60000}, ${now}, ${now}),
      ('canonical-request-standard', 'tool_approval', 'conversation', 'vellum', 'conv-standard', 'CANS01', 'pending', ${now + 60000}, ${now}, ${now});

    INSERT INTO canonical_guardian_deliveries (
      id,
      request_id,
      destination_channel,
      destination_conversation_id,
      destination_chat_id,
      destination_message_id,
      status,
      created_at,
      updated_at
    ) VALUES
      ('canonical-delivery-private-request', 'canonical-request-private-source', 'vellum', 'conv-standard', 'chat-standard', 'message-standard', 'pending', ${now}, ${now}),
      ('canonical-delivery-private-destination', 'canonical-request-private-destination', 'vellum', 'conv-private', 'chat-private', 'message-private', 'pending', ${now}, ${now}),
      ('canonical-delivery-standard', 'canonical-request-standard', 'vellum', 'conv-standard', 'chat-standard', 'message-standard', 'pending', ${now}, ${now});

    INSERT INTO scoped_approval_grants (
      id,
      scope_mode,
      request_id,
      tool_name,
      input_digest,
      request_channel,
      decision_channel,
      conversation_id,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES
      ('scoped-grant-private', 'request_id', 'canonical-request-private-source', NULL, NULL, 'vellum', 'vellum', 'conv-private', 'active', ${now + 60000}, ${now}, ${now}),
      ('scoped-grant-standard', 'request_id', 'canonical-request-standard', NULL, NULL, 'vellum', 'vellum', 'conv-standard', 'active', ${now + 60000}, ${now}, ${now}),
      ('scoped-grant-unscoped', 'tool_signature', NULL, 'test_tool', 'digest-123', 'vellum', 'vellum', NULL, 'active', ${now + 60000}, ${now}, ${now});

    INSERT INTO scoped_approval_grants (
      id,
      scope_mode,
      request_id,
      tool_name,
      input_digest,
      request_channel,
      decision_channel,
      conversation_id,
      call_session_id,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES
      ('scoped-grant-private-call-only', 'tool_signature', NULL, 'test_tool', 'digest-456', 'vellum', 'vellum', NULL, 'call-private-guardian', 'active', ${now + 60000}, ${now}, ${now});

    INSERT INTO channel_guardian_approval_requests (
      id,
      run_id,
      request_id,
      conversation_id,
      channel,
      requester_external_user_id,
      requester_chat_id,
      guardian_external_user_id,
      guardian_chat_id,
      tool_name,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES
      ('channel-approval-private', 'run-private', 'request-private', 'conv-private', 'telegram', 'user-123', 'chat-private', 'guardian-123', 'guardian-chat', 'test_tool', 'pending', ${now + 60000}, ${now}, ${now}),
      ('channel-approval-standard', 'run-standard', 'request-standard', 'conv-standard', 'telegram', 'user-123', 'chat-standard', 'guardian-123', 'guardian-chat', 'test_tool', 'pending', ${now + 60000}, ${now}, ${now});
  `);
}

function seedSharedAttachment(raw: Database, now: number): void {
  raw.exec(/*sql*/ `
    INSERT INTO attachments (
      id,
      original_filename,
      mime_type,
      size_bytes,
      kind,
      data_base64,
      created_at
    ) VALUES (
      'attachment-shared-private-standard',
      'shared.txt',
      'text/plain',
      1,
      'text',
      'eA==',
      ${now}
    );

    INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
    VALUES
      ('message-attachment-shared-private', 'conv-private-message', 'attachment-shared-private-standard', 1, ${now}),
      ('message-attachment-shared-standard', 'conv-standard-message', 'attachment-shared-private-standard', 1, ${now});
  `);
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

function getVectorCleanupJobs(raw: Database): Array<{
  id: string;
  payload: string;
}> {
  return raw
    .query(
      `SELECT id, payload FROM memory_jobs
       WHERE type = 'delete_qdrant_vectors'
       ORDER BY id`,
    )
    .all() as Array<{ id: string; payload: string }>;
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
    seedGuardianAndApprovalRows(raw, now);
    seedGraphRows(raw, now);
    seedSharedAttachment(raw, now);

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
    const vectorCleanupJobsAfterFirstRun = getVectorCleanupJobs(raw);
    migrateDeletePrivateConversations(db);
    const vectorCleanupJobsAfterSecondRun = getVectorCleanupJobs(raw);
    expect(vectorCleanupJobsAfterSecondRun).toEqual(
      vectorCleanupJobsAfterFirstRun,
    );

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
      countWhere(raw, "memory_graph_nodes", `scope_id LIKE 'private:%'`),
    ).toBe(0);
    expect(countWhere(raw, "memory_graph_nodes", `id = 'graph-standard'`)).toBe(
      1,
    );
    expect(
      countWhere(raw, "memory_graph_nodes", `id = 'graph-background'`),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "memory_graph_edges",
        `id IN ('edge-private-source', 'edge-private-target')`,
      ),
    ).toBe(0);
    expect(
      countWhere(raw, "memory_graph_edges", `id = 'edge-standard-background'`),
    ).toBe(1);
    expect(
      countWhere(raw, "memory_graph_triggers", `id = 'trigger-private'`),
    ).toBe(0);
    expect(
      countWhere(raw, "memory_graph_triggers", `id = 'trigger-standard'`),
    ).toBe(1);
    expect(
      countWhere(raw, "memory_graph_triggers", `id = 'trigger-background'`),
    ).toBe(1);
    expect(
      countWhere(raw, "memory_graph_node_edits", `id = 'edit-private'`),
    ).toBe(0);
    expect(
      countWhere(raw, "memory_graph_node_edits", `id = 'edit-standard'`),
    ).toBe(1);
    expect(
      countWhere(raw, "memory_graph_node_edits", `id = 'edit-background'`),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "memory_embeddings",
        `id IN ('graph-private-a-embedding', 'graph-private-b-embedding')`,
      ),
    ).toBe(0);
    expect(
      countWhere(raw, "memory_embeddings", `id = 'graph-standard-embedding'`),
    ).toBe(1);
    expect(
      countWhere(raw, "memory_embeddings", `id = 'graph-background-embedding'`),
    ).toBe(1);

    expect(vectorCleanupJobsAfterSecondRun).toEqual([
      {
        id: "migration-229-delete-private-graph-node-vector:graph-private-a",
        payload: '{"targetType":"graph_node","targetId":"graph-private-a"}',
      },
      {
        id: "migration-229-delete-private-graph-node-vector:graph-private-b",
        payload: '{"targetType":"graph_node","targetId":"graph-private-b"}',
      },
      {
        id: "migration-229-delete-private-segment-vector:conv-private-segment",
        payload: '{"targetType":"segment","targetId":"conv-private-segment"}',
      },
      {
        id: "migration-229-delete-private-summary-vector:summary-private",
        payload: '{"targetType":"summary","targetId":"summary-private"}',
      },
    ]);
    expect(
      countWhere(raw, "memory_jobs", `id = 'job-standard-embed-graph-node'`),
    ).toBe(1);

    expect(
      countWhere(raw, "attachments", `id = 'conv-private-attachment'`),
    ).toBe(0);
    expect(
      countWhere(raw, "attachments", `id = 'conv-standard-attachment'`),
    ).toBe(1);
    expect(
      countWhere(raw, "attachments", `id = 'conv-background-attachment'`),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "attachments",
        `id = 'attachment-shared-private-standard'`,
      ),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "message_attachments",
        `id = 'message-attachment-shared-private'`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "message_attachments",
        `id = 'message-attachment-shared-standard'`,
      ),
    ).toBe(1);
    expect(
      countWhere(raw, "conversation_starters", `scope_id = 'default'`),
    ).toBe(1);
    expect(
      countWhere(raw, "conversation_starters", `scope_id LIKE 'background:%'`),
    ).toBe(1);

    expect(
      countWhere(
        raw,
        "canonical_guardian_requests",
        `id = 'canonical-request-private-source'`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "canonical_guardian_requests",
        `id = 'canonical-request-private-destination'`,
      ),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "canonical_guardian_requests",
        `id = 'canonical-request-standard'`,
      ),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "canonical_guardian_deliveries",
        `id IN ('canonical-delivery-private-request', 'canonical-delivery-private-destination')`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "canonical_guardian_deliveries",
        `id = 'canonical-delivery-standard'`,
      ),
    ).toBe(1);
    expect(
      countWhere(raw, "scoped_approval_grants", `id = 'scoped-grant-private'`),
    ).toBe(0);
    expect(
      countWhere(raw, "scoped_approval_grants", `id = 'scoped-grant-standard'`),
    ).toBe(1);
    expect(
      countWhere(raw, "scoped_approval_grants", `id = 'scoped-grant-unscoped'`),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "scoped_approval_grants",
        `id = 'scoped-grant-private-call-only'`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "guardian_action_requests",
        `id = 'legacy-request-private-source'`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "guardian_action_requests",
        `id = 'legacy-request-private-destination'`,
      ),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "guardian_action_requests",
        `id = 'legacy-request-standard'`,
      ),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "guardian_action_deliveries",
        `id IN ('legacy-delivery-private-request', 'legacy-delivery-private-destination')`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "guardian_action_deliveries",
        `id = 'legacy-delivery-standard'`,
      ),
    ).toBe(1);
    expect(
      countWhere(
        raw,
        "channel_guardian_approval_requests",
        `id = 'channel-approval-private'`,
      ),
    ).toBe(0);
    expect(
      countWhere(
        raw,
        "channel_guardian_approval_requests",
        `id = 'channel-approval-standard'`,
      ),
    ).toBe(1);
  });
});
