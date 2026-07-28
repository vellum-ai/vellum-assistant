/**
 * Shared test helpers for the conversation-keyed memory tables that were
 * relocated to the memory connection. Seeding and counting live here so every
 * drift-guard test can iterate {@link CONVERSATION_KEYED_MEMORY_TABLES} and
 * automatically cover a table the moment it joins that array.
 */
import { getMemorySqlite } from "../../../../persistence/db-connection.js";

/** Insert one row keyed to `conversationId` into a relocated memory table. */
export function seedRelocatedMemoryRow(
  table: string,
  conversationId: string,
): void {
  const raw = getMemorySqlite()!;
  const now = Date.now();
  switch (table) {
    case "memory_v2_activation_logs":
      raw
        .query(
          `INSERT INTO memory_v2_activation_logs
             (id, conversation_id, turn, mode, concepts_json, skills_json, config_json, created_at)
           VALUES (?, ?, 1, 'per-turn', '[]', '[]', '{}', ?)`,
        )
        .run(`${conversationId}-al`, conversationId, now);
      return;
    case "memory_recall_logs":
      raw
        .query(
          `INSERT INTO memory_recall_logs
             (id, conversation_id, enabled, degraded, semantic_hits, merged_count,
              selected_count, tier1_count, tier2_count, hybrid_search_latency_ms,
              sparse_vector_used, injected_tokens, latency_ms, top_candidates_json, created_at)
           VALUES (?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '[]', ?)`,
        )
        .run(`${conversationId}-rl`, conversationId, now);
      return;
    case "memory_v3_selections":
      raw
        .query(
          `INSERT INTO memory_v3_selections
             (conversation_id, turn, slug, source, created_at)
           VALUES (?, 1, 'domain/page', 'auto', ?)`,
        )
        .run(conversationId, now);
      return;
    case "activation_sessions":
      raw
        .query(
          `INSERT INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)`,
        )
        .run(conversationId, now);
      return;
    case "activation_state":
      raw
        .query(
          `INSERT INTO activation_state
             (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
           VALUES (?, ?, '{}', '[]', 0, ?)`,
        )
        .run(conversationId, `${conversationId}-msg`, now);
      return;
    case "conversation_graph_memory_state":
      raw
        .query(
          `INSERT INTO conversation_graph_memory_state
             (conversation_id, state_json, created_at, updated_at)
           VALUES (?, '{}', ?, ?)`,
        )
        .run(conversationId, now, now);
      return;
    case "memory_v3_ever_injected":
      raw
        .query(
          `INSERT INTO memory_v3_ever_injected
             (conversation_id, slug, injected_at, bytes, pruned_at)
           VALUES (?, 'domain/page', ?, 0, NULL)`,
        )
        .run(conversationId, now);
      return;
    case "memory_retrospective_state":
      raw
        .query(
          `INSERT INTO memory_retrospective_state
             (conversation_id, last_processed_message_id, last_run_at, remembered_log)
           VALUES (?, '', ?, NULL)`,
        )
        .run(conversationId, now);
      return;
    default:
      throw new Error(`unhandled relocated memory table ${table}`);
  }
}

/** Count `conversationId`'s rows in a relocated memory table. */
export function relocatedMemoryRowCount(
  table: string,
  conversationId: string,
): number {
  const { n } = getMemorySqlite()!
    .query(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?`)
    .get(conversationId) as { n: number };
  return n;
}
