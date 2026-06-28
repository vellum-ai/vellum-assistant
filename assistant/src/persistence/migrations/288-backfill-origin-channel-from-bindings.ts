import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Fully normalize `conversations.origin_channel` so no rows remain NULL.
 *
 * Step 1: Backfill from `external_conversation_bindings.source_channel` for
 * conversations that have a channel binding but NULL origin_channel (created
 * before origin_channel was consistently set on first inbound message).
 *
 * Step 2: Set remaining NULL rows to 'vellum'. These are native/local
 * conversations created before the mechanism existed — they have no external
 * binding and were always implicitly vellum-channel conversations.
 */
export function migrateBackfillOriginChannelFromBindings(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Step 1: Backfill from external bindings
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

  // Step 2: Remaining NULL rows are native/local — set to 'vellum'
  raw
    .query(
      /*sql*/ `UPDATE conversations SET origin_channel = 'vellum' WHERE origin_channel IS NULL`,
    )
    .run();
}
