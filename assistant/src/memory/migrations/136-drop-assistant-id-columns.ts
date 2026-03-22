import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v19: add assistant_id columns back to all 16 tables via
 * ALTER TABLE ADD COLUMN, defaulting to 'self'.
 *
 * This restores the column that the forward migration dropped. All rows
 * get assistant_id = 'self' since that was the only value before dropping.
 */
export function downDropAssistantIdColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

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

  for (const table of tables) {
    // Skip if table doesn't exist
    const tableExists = raw
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableExists) continue;

    // Skip if column already exists (idempotent)
    const colExists = raw
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'assistant_id'`)
      .get(table);
    if (colExists) continue;

    try {
      raw.exec(
        /*sql*/ `ALTER TABLE ${table} ADD COLUMN assistant_id TEXT NOT NULL DEFAULT 'self'`,
      );
    } catch {
      /* column may already exist from partial run */
    }
  }
}

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

    // --- Drop ALL indexes that include assistant_id ---
    // Every index below references the assistant_id column. SQLite will error
    // on ALTER TABLE ... DROP COLUMN if any index still references the column.

    // channel_guardian_verification_challenges indexes (migrations 110, 026, 027a)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_channel_guardian_challenges_lookup`,
    );
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_active`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_identity`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_destination`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_bootstrap`);

    // channel_guardian_rate_limits indexes (migration 110)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_channel_guardian_rate_limits_actor`,
    );

    // assistant_ingress_invites indexes (migration 112)
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_ingress_invites_channel_status`);
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_ingress_invites_channel_created`,
    );

    // assistant_inbox_thread_state indexes (migration 112)
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_inbox_thread_state_channel`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_inbox_thread_state_last_msg`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_inbox_thread_state_escalation`);

    // notification_preferences indexes (migration 114)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_notification_preferences_assistant_id`,
    );
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_notification_preferences_assistant_priority`,
    );

    // notification_events indexes (migration 114)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_notification_events_assistant_event_created`,
    );
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_notification_events_dedupe`);

    // notification_deliveries indexes (migration 114)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_notification_deliveries_assistant_status`,
    );

    // conversation_attention_events indexes (migration 117)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_conv_attn_events_assistant_observed`,
    );

    // conversation_assistant_attention_state indexes (migration 117)
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_conv_attn_state_assistant_latest_msg`,
    );
    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_conv_attn_state_assistant_last_seen`,
    );

    // actor_token_records indexes (migration 038)
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_actor_tokens_active_device`);

    // actor_refresh_token_records indexes (migration 039)
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_refresh_tokens_active_device`);

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
    // Each index below is the equivalent of the dropped index but with the
    // assistant_id column removed. Index names are updated to avoid
    // collisions with the old names.

    // channel_guardian_verification_challenges
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_challenges_lookup ON channel_guardian_verification_challenges(channel, challenge_hash, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_active ON channel_guardian_verification_challenges(channel, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_identity ON channel_guardian_verification_challenges(channel, expected_external_user_id, expected_chat_id, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_destination ON channel_guardian_verification_challenges(channel, destination_address)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_bootstrap ON channel_guardian_verification_challenges(channel, bootstrap_token_hash, status)`,
    );

    // channel_guardian_rate_limits
    raw.exec(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_rate_limits_actor ON channel_guardian_rate_limits(channel, actor_external_user_id, actor_chat_id)`,
    );

    // assistant_ingress_invites
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_status ON assistant_ingress_invites(source_channel, status, expires_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_created ON assistant_ingress_invites(source_channel, created_at)`,
    );

    // assistant_inbox_thread_state
    raw.exec(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_thread_state_channel ON assistant_inbox_thread_state(source_channel, external_chat_id)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_last_msg ON assistant_inbox_thread_state(last_message_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_escalation ON assistant_inbox_thread_state(has_pending_escalation, last_message_at)`,
    );

    // notification_preferences
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_preferences_priority ON notification_preferences(priority DESC)`,
    );

    // notification_events
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_events_event_created ON notification_events(source_event_name, created_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedupe ON notification_events(dedupe_key) WHERE dedupe_key IS NOT NULL`,
    );

    // notification_deliveries
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status)`,
    );

    // conversation_attention_events
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_events_observed ON conversation_attention_events(observed_at)`,
    );

    // conversation_assistant_attention_state
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_latest_msg ON conversation_assistant_attention_state(latest_assistant_message_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_last_seen ON conversation_assistant_attention_state(last_seen_assistant_message_at)`,
    );

    // actor_token_records
    raw.exec(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_tokens_active_device ON actor_token_records(guardian_principal_id, hashed_device_id) WHERE status = 'active'`,
    );

    // actor_refresh_token_records
    raw.exec(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_active_device ON actor_refresh_token_records(guardian_principal_id, hashed_device_id) WHERE status = 'active'`,
    );

    log.info("Completed dropping assistant_id columns from all tables");
  });
}
