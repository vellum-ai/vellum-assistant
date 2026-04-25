import type { DrizzleDb } from "../db-connection.js";

const REMOVED_CONVERSATION_TYPE = "private";
const REMOVED_CONVERSATION_TYPE_SQL = `'${REMOVED_CONVERSATION_TYPE}'`;

const PRIVATE_CONVERSATION_IDS = /*sql*/ `
  SELECT id FROM conversations WHERE conversation_type = ${REMOVED_CONVERSATION_TYPE_SQL}
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
    DELETE FROM memory_embeddings
    WHERE target_type = 'segment'
      AND target_id IN (
        SELECT id FROM memory_segments
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
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
