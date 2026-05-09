import type { DrizzleDb } from "../db-connection.js";

const REMOVED_CONVERSATION_TYPE = "private";
const REMOVED_CONVERSATION_TYPE_SQL = `'${REMOVED_CONVERSATION_TYPE}'`;

const PRIVATE_CONVERSATION_IDS = /*sql*/ `
  SELECT id FROM conversations WHERE conversation_type = ${REMOVED_CONVERSATION_TYPE_SQL}
`;

const PRIVATE_GRAPH_NODE_IDS = /*sql*/ `
  SELECT id FROM memory_graph_nodes WHERE scope_id LIKE 'private:%'
`;

export function migrateDeletePrivateConversations(database: DrizzleDb): void {
  database.run(/*sql*/ `
    DELETE FROM tool_invocations
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM llm_request_logs
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_recall_logs
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM llm_usage_events
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM trace_events
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM canonical_guardian_deliveries
    WHERE destination_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
       OR request_id IN (
        SELECT id FROM canonical_guardian_requests
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM canonical_guardian_requests
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM scoped_approval_grants
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
       OR call_session_id IN (
        SELECT id FROM call_sessions
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM guardian_action_deliveries
    WHERE destination_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
       OR request_id IN (
        SELECT id FROM guardian_action_requests
        WHERE source_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM guardian_action_requests
    WHERE source_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM channel_guardian_approval_requests
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    INSERT OR IGNORE INTO memory_jobs (
      id,
      type,
      payload,
      status,
      attempts,
      run_after,
      created_at,
      updated_at
    )
    SELECT
      'migration-229-delete-private-segment-vector:' || id,
      'delete_qdrant_vectors',
      json_object('targetType', 'segment', 'targetId', id),
      'pending',
      0,
      0,
      0,
      0
    FROM memory_segments
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_embeddings
    WHERE target_type = 'segment'
      AND target_id IN (
        SELECT id FROM memory_segments
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    INSERT OR IGNORE INTO memory_jobs (
      id,
      type,
      payload,
      status,
      attempts,
      run_after,
      created_at,
      updated_at
    )
    SELECT
      'migration-229-delete-private-summary-vector:' || id,
      'delete_qdrant_vectors',
      json_object('targetType', 'summary', 'targetId', id),
      'pending',
      0,
      0,
      0,
      0
    FROM memory_summaries
    WHERE scope_id LIKE 'private:%'
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_embeddings
    WHERE target_type = 'summary'
      AND target_id IN (
        SELECT id FROM memory_summaries
        WHERE scope_id LIKE 'private:%'
      )
  `);
  database.run(/*sql*/ `
    INSERT OR IGNORE INTO memory_jobs (
      id,
      type,
      payload,
      status,
      attempts,
      run_after,
      created_at,
      updated_at
    )
    SELECT
      'migration-229-delete-private-graph-node-vector:' || id,
      'delete_qdrant_vectors',
      json_object('targetType', 'graph_node', 'targetId', id),
      'pending',
      0,
      0,
      0,
      0
    FROM memory_graph_nodes
    WHERE scope_id LIKE 'private:%'
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_embeddings
    WHERE target_type = 'graph_node'
      AND target_id IN (${PRIVATE_GRAPH_NODE_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_graph_node_edits
    WHERE node_id IN (${PRIVATE_GRAPH_NODE_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_graph_triggers
    WHERE node_id IN (${PRIVATE_GRAPH_NODE_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_graph_edges
    WHERE source_node_id IN (${PRIVATE_GRAPH_NODE_IDS})
       OR target_node_id IN (${PRIVATE_GRAPH_NODE_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_graph_nodes
    WHERE scope_id LIKE 'private:%'
  `);
  database.run(/*sql*/ `
    DELETE FROM attachments
    WHERE EXISTS (
      SELECT 1
      FROM message_attachments ma
      JOIN messages m ON m.id = ma.message_id
      WHERE ma.attachment_id = attachments.id
        AND m.conversation_id IN (${PRIVATE_CONVERSATION_IDS})
    )
      AND NOT EXISTS (
        SELECT 1
        FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE ma.attachment_id = attachments.id
          AND c.conversation_type != ${REMOVED_CONVERSATION_TYPE_SQL}
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM messages
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_summaries
    WHERE scope_id LIKE 'private:%'
  `);
  database.run(/*sql*/ `
    DELETE FROM conversation_starters
    WHERE scope_id LIKE 'private:%'
  `);

  // Qdrant vectors for deleted embedding rows are cleaned up by background sweeps.
  database.run(/*sql*/ `
    DELETE FROM conversations
    WHERE conversation_type = ${REMOVED_CONVERSATION_TYPE_SQL}
  `);
}
