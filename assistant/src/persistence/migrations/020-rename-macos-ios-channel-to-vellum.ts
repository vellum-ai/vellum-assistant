import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: rename 'macos' and 'ios' channel identifiers to 'vellum'
 * across all tables that store channel values.
 *
 * Uses a checkpoint key for idempotency.
 */
export function migrateRenameChannelToVellum(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_rename_macos_ios_channel_to_vellum_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec("BEGIN");

    // guardian_action_deliveries.destination_channel
    const gadExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guardian_action_deliveries'`,
      )
      .get();
    if (gadExists) {
      raw
        .query(
          `UPDATE guardian_action_deliveries SET destination_channel = 'vellum' WHERE destination_channel IN ('macos', 'ios')`,
        )
        .run();
    }

    // messages.user_message_channel / assistant_message_channel
    const msgsExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      )
      .get();
    if (msgsExists) {
      // Check if columns exist before updating
      const hasUserMsgChannel = raw
        .query(
          `SELECT 1 FROM pragma_table_info('messages') WHERE name = 'user_message_channel'`,
        )
        .get();
      if (hasUserMsgChannel) {
        raw
          .query(
            `UPDATE messages SET user_message_channel = 'vellum' WHERE user_message_channel IN ('macos', 'ios')`,
          )
          .run();
      }
      const hasAssistantMsgChannel = raw
        .query(
          `SELECT 1 FROM pragma_table_info('messages') WHERE name = 'assistant_message_channel'`,
        )
        .get();
      if (hasAssistantMsgChannel) {
        raw
          .query(
            `UPDATE messages SET assistant_message_channel = 'vellum' WHERE assistant_message_channel IN ('macos', 'ios')`,
          )
          .run();
      }
    }

    // external_conversation_bindings.source_channel
    const ecbExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_conversation_bindings'`,
      )
      .get();
    if (ecbExists) {
      raw
        .query(
          `UPDATE external_conversation_bindings SET source_channel = 'vellum' WHERE source_channel IN ('macos', 'ios')`,
        )
        .run();
    }

    // assistant_inbox_thread_state.source_channel
    const aitsExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_inbox_thread_state'`,
      )
      .get();
    if (aitsExists) {
      raw
        .query(
          `UPDATE assistant_inbox_thread_state SET source_channel = 'vellum' WHERE source_channel IN ('macos', 'ios')`,
        )
        .run();
    }

    // conversations.origin_channel
    const convExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`,
      )
      .get();
    if (convExists) {
      const hasOriginChannel = raw
        .query(
          `SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'origin_channel'`,
        )
        .get();
      if (hasOriginChannel) {
        raw
          .query(
            `UPDATE conversations SET origin_channel = 'vellum' WHERE origin_channel IN ('macos', 'ios')`,
          )
          .run();
      }
    }

    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}

/**
 * Reverse the channel rename by changing "vellum" back to "macos" in all tables.
 *
 * NOTE: The forward migration renamed both "macos" and "ios" to "vellum", so we
 * cannot distinguish which rows were originally "ios". This down migration
 * conservatively maps all "vellum" values back to "macos" since that was the
 * primary desktop channel identifier.
 */
export function downRenameChannelToVellum(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec("BEGIN");

    // guardian_action_deliveries.destination_channel
    const gadExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guardian_action_deliveries'`,
      )
      .get();
    if (gadExists) {
      raw
        .query(
          `UPDATE guardian_action_deliveries SET destination_channel = 'macos' WHERE destination_channel = 'vellum'`,
        )
        .run();
    }

    // messages.user_message_channel / assistant_message_channel
    const msgsExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      )
      .get();
    if (msgsExists) {
      const hasUserMsgChannel = raw
        .query(
          `SELECT 1 FROM pragma_table_info('messages') WHERE name = 'user_message_channel'`,
        )
        .get();
      if (hasUserMsgChannel) {
        raw
          .query(
            `UPDATE messages SET user_message_channel = 'macos' WHERE user_message_channel = 'vellum'`,
          )
          .run();
      }
      const hasAssistantMsgChannel = raw
        .query(
          `SELECT 1 FROM pragma_table_info('messages') WHERE name = 'assistant_message_channel'`,
        )
        .get();
      if (hasAssistantMsgChannel) {
        raw
          .query(
            `UPDATE messages SET assistant_message_channel = 'macos' WHERE assistant_message_channel = 'vellum'`,
          )
          .run();
      }
    }

    // external_conversation_bindings.source_channel
    const ecbExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_conversation_bindings'`,
      )
      .get();
    if (ecbExists) {
      raw
        .query(
          `UPDATE external_conversation_bindings SET source_channel = 'macos' WHERE source_channel = 'vellum'`,
        )
        .run();
    }

    // assistant_inbox_thread_state.source_channel
    const aitsExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_inbox_thread_state'`,
      )
      .get();
    if (aitsExists) {
      raw
        .query(
          `UPDATE assistant_inbox_thread_state SET source_channel = 'macos' WHERE source_channel = 'vellum'`,
        )
        .run();
    }

    // conversations.origin_channel
    const convExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`,
      )
      .get();
    if (convExists) {
      const hasOriginChannel = raw
        .query(
          `SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'origin_channel'`,
        )
        .get();
      if (hasOriginChannel) {
        raw
          .query(
            `UPDATE conversations SET origin_channel = 'macos' WHERE origin_channel = 'vellum'`,
          )
          .run();
      }
    }

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}
