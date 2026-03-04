import type { DrizzleDb } from "../db-connection.js";

/**
 * Add a composite index on (type, external_chat_id) for contact_channels.
 *
 * updateChannelLastSeenByExternalChatId filters on this column pair on every
 * inbound message for chat-id-only members; without the index each call
 * performs a table scan.
 */
export function migrateContactChannelsTypeChatIdIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_contact_channels_type_ext_chat ON contact_channels(type, external_chat_id)`,
  );
}
