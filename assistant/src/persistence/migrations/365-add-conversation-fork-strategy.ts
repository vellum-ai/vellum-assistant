import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add `fork_strategy` to `conversations`, the discriminator that says whether
 * a fork's inherited history lives on the fork (copied) or on its parent
 * (read through `fork_parent_message_id`).
 *
 * The column is required even though `fork_parent_conversation_id` and
 * `fork_parent_message_id` already exist, because both are set on copied
 * forks too. Without a discriminator, a lineage read cannot tell a fork whose
 * prefix it must fetch from the parent from one that already holds its own
 * copy of that prefix, and would return the copied rows twice.
 *
 * Nullable with no backfill: every fork that exists when this runs was
 * materialized by copying, and `isReferentialFork` reads NULL as `cloning`.
 * A backfill would have to write a value to every historical conversation row
 * to encode what the absence of a value already means.
 *
 * Idempotent: the column add is guarded with `tableHasColumn`, so a crash
 * partway through does not break the next boot.
 */
export function migrateAddConversationForkStrategy(database: DrizzleDb): void {
  if (!tableHasColumn(database, "conversations", "fork_strategy")) {
    database.run(`ALTER TABLE conversations ADD COLUMN fork_strategy TEXT`);
  }
}
