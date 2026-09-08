import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const INDEX = "idx_channel_inbound_events_message_id";

/**
 * Index the inbound-event to message link.
 *
 * Three queries filter on `message_id`: the sibling lookups on the
 * redelivery path (`getSiblingStreamedReplyTs`,
 * `isDeduplicatedDeliveryOwnedBySibling`) and the NOT EXISTS prefilter in
 * `findMessageByProviderMessageId` that skips rows the inbound-event
 * index already resolves. Without this index each is a full table scan.
 *
 * Partial, on linked rows only: unlinked events (crash-window orphans,
 * reactions before linking) contribute nothing to it.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateChannelInboundMessageIdIndex(database: DrizzleDb): void {
  getSqliteFrom(database).exec(
    `CREATE INDEX IF NOT EXISTS ${INDEX}
       ON channel_inbound_events (message_id)
       WHERE message_id IS NOT NULL`,
  );
}
