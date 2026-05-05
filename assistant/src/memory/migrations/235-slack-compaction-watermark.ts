import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_slack_compaction_watermark_v1";

const COLUMNS = [
  {
    name: "slack_context_compaction_watermark_ts",
    definition: "slack_context_compaction_watermark_ts TEXT",
  },
  {
    name: "slack_context_compaction_watermark_at",
    definition: "slack_context_compaction_watermark_at INTEGER",
  },
] as const;

/**
 * Add Slack-specific compaction state to conversations.
 *
 * The existing context_compacted_message_count remains the generic DB-row
 * compaction boundary. Slack threads need a source timestamp watermark because
 * late thread mentions can arrive with historical Slack ts values independent
 * of local insertion order.
 */
export function migrateSlackCompactionWatermark(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    for (const column of COLUMNS) {
      if (tableHasColumn(database, "conversations", column.name)) {
        continue;
      }
      database.run(`ALTER TABLE conversations ADD COLUMN ${column.definition}`);
    }
  });
}

export function downSlackCompactionWatermark(database: DrizzleDb): void {
  for (const column of COLUMNS) {
    if (!tableHasColumn(database, "conversations", column.name)) {
      continue;
    }
    database.run(`ALTER TABLE conversations DROP COLUMN ${column.name}`);
  }
}
