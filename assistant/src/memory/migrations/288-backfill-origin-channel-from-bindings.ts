import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Backfill `conversations.origin_channel` from
 * `external_conversation_bindings.source_channel` for conversations where
 * origin_channel is NULL but a binding exists. This handles conversations
 * created before origin_channel was consistently set on the first inbound
 * channel message.
 */
export function migrateBackfillOriginChannelFromBindings(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw
    .query(
      /*sql*/ `
      UPDATE conversations
      SET origin_channel = (
        SELECT source_channel
        FROM external_conversation_bindings
        WHERE external_conversation_bindings.conversation_id = conversations.id
      )
      WHERE origin_channel IS NULL
        AND id IN (
          SELECT conversation_id FROM external_conversation_bindings
        )
    `,
    )
    .run();
}
