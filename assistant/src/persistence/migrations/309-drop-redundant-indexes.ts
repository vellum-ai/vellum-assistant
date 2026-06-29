import type { DrizzleDb } from "../db-connection.js";

/**
 * Drop nine redundant single-/narrow-column indexes whose columns are a
 * leading prefix of a wider, non-partial index already present on the same
 * table. SQLite uses the wider index to serve the narrower lookup (a prefix of
 * its key), so the narrow index adds nothing on reads while still costing a
 * B-tree write on every insert/update to the table. Dropping them trims
 * write-amplification on hot tables (`messages`, `trace_events`,
 * `notification_deliveries`) and frees space on the rest.
 *
 * Each drop and the index that subsumes it (verified non-partial, so it covers
 * all rows the narrow index did):
 *
 *   messages
 *     idx_messages_conversation_id [conversation_id]
 *       ⊂ idx_messages_conversation_created_at [conversation_id, created_at]
 *   trace_events
 *     idx_trace_events_conversation_id [conversation_id]
 *       ⊂ idx_trace_events_conversation_timestamp [conversation_id, timestamp_ms]
 *   notification_deliveries
 *     idx_notification_deliveries_decision_id [notification_decision_id]
 *       ⊂ idx_notification_deliveries_unique
 *           [notification_decision_id, channel, destination, attempt]
 *   external_conversation_bindings
 *     idx_ext_conv_bindings_channel [source_channel]
 *     idx_ext_conv_bindings_channel_chat [source_channel, external_chat_id]
 *       both ⊂ idx_ext_conv_bindings_channel_chat_thread
 *           [source_channel, external_chat_id, external_thread_id]
 *   followups
 *     idx_followups_channel [channel] ⊂ idx_followups_channel_thread
 *           [channel, conversation_id]
 *     idx_followups_status [status] ⊂ idx_followups_status_expected
 *           [status, expected_response_by]
 *   guardian_action_requests
 *     idx_guardian_action_requests_call_session [call_session_id]
 *       ⊂ idx_guardian_action_requests_session_status_created
 *           [call_session_id, status, created_at]
 *   media_keyframes
 *     idx_media_keyframes_asset_id [asset_id]
 *       ⊂ idx_media_keyframes_asset_timestamp [asset_id, timestamp]
 *
 * `IF EXISTS` keeps this idempotent and tolerant of databases where an index
 * was never created.
 */
export function migrateDropRedundantIndexes(database: DrizzleDb): void {
  for (const name of [
    "idx_messages_conversation_id",
    "idx_trace_events_conversation_id",
    "idx_notification_deliveries_decision_id",
    "idx_ext_conv_bindings_channel",
    "idx_ext_conv_bindings_channel_chat",
    "idx_followups_channel",
    "idx_followups_status",
    "idx_guardian_action_requests_call_session",
    "idx_media_keyframes_asset_id",
  ]) {
    database.run(/*sql*/ `DROP INDEX IF EXISTS ${name}`);
  }
}
