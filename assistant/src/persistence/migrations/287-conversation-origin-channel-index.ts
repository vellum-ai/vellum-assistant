import type { DrizzleDb } from "../db-connection.js";

/**
 * Add an index on `origin_channel` to support the new `originChannel` query
 * parameter on `GET /v1/conversations`. Channel-based sidebar sections fetch
 * conversations filtered by origin channel; without this index, each such
 * query requires a full table scan.
 */
export function migrateConversationOriginChannelIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_origin_channel ON conversations(origin_channel)`,
  );
}
