import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const log = getLogger("migration-136");

/**
 * Drop `assistant_id` columns from all 16 daemon tables that carried the
 * per-assistant scoping column. After wave-1 PRs normalised every value to
 * 'self' (the implicit single-tenant identity), the column is dead weight.
 *
 * Steps:
 *  1. Safety assertion: verify all rows are 'self' or NULL.
 *  2. Drop composite indexes that include `assistant_id`.
 *  3. `ALTER TABLE ... DROP COLUMN assistant_id` for each table.
 *  4. Recreate indexes without the `assistant_id` column.
 */
export function migrateDropAssistantIdColumns(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_drop_assistant_id_columns_v1", () => {
    const raw = getSqliteFrom(database);

    // The 16 tables that carry assistant_id.
    const tables = [
      "contacts",
      "assistant_ingress_invites",
      "assistant_inbox_thread_state",
      "call_sessions",
      "channel_guardian_verification_challenges",
      "channel_guardian_approval_requests",
      "channel_guardian_rate_limits",
      "guardian_action_requests",
      "scoped_approval_grants",
      "notification_events",
      "notification_preferences",
      "notification_deliveries",
      "conversation_attention_events",
      "conversation_assistant_attention_state",
      "actor_token_records",
      "actor_refresh_token_records",
    ];

    // --- Safety assertion ---
    // Verify all existing assistant_id values are 'self' or NULL before dropping.
    for (const table of tables) {
      const cols = new Set(
        (
          raw.query(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );

      if (!cols.has("assistant_id")) {
        log.info(
          { table },
          "Table does not have assistant_id column — skipping",
        );
        continue;
      }

      const unexpected = raw
        .query(
          `SELECT DISTINCT assistant_id FROM ${table} WHERE assistant_id IS NOT NULL AND assistant_id != 'self'`,
        )
        .all() as Array<{ assistant_id: string }>;

      if (unexpected.length > 0) {
        log.warn(
          { table, values: unexpected.map((r) => r.assistant_id) },
          "Unexpected assistant_id values found — skipping table",
        );
        continue;
      }
    }

    // --- Drop indexes that include assistant_id ---
    // conversation_attention_events indexes
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_conv_attn_events_assistant_observed`,
    );
    // conversation_assistant_attention_state indexes
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_conv_attn_state_assistant_latest_msg`,
    );
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_conv_attn_state_assistant_last_seen`,
    );

    // --- Drop assistant_id column from each table ---
    for (const table of tables) {
      const cols = new Set(
        (
          raw.query(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );

      if (!cols.has("assistant_id")) continue;

      // Re-verify safety before each drop
      const unexpected = raw
        .query(
          `SELECT DISTINCT assistant_id FROM ${table} WHERE assistant_id IS NOT NULL AND assistant_id != 'self'`,
        )
        .all() as Array<{ assistant_id: string }>;

      if (unexpected.length > 0) {
        log.warn(
          { table, values: unexpected.map((r) => r.assistant_id) },
          "Unexpected assistant_id values — skipping column drop",
        );
        continue;
      }

      raw.exec(/*sql*/ `ALTER TABLE ${table} DROP COLUMN assistant_id`);
      log.info({ table }, "Dropped assistant_id column");
    }

    // --- Recreate indexes without assistant_id ---
    // conversation_attention_events: preserve (observedAt) only
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_events_observed ON conversation_attention_events (observed_at)`,
    );
    // conversation_assistant_attention_state: preserve (latestAssistantMessageAt) and (lastSeenAssistantMessageAt)
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_latest_msg ON conversation_assistant_attention_state (latest_assistant_message_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_last_seen ON conversation_assistant_attention_state (last_seen_assistant_message_at)`,
    );

    log.info("Completed dropping assistant_id columns from all tables");
  });
}
