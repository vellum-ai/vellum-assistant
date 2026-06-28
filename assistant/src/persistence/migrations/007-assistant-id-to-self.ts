import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: normalize all assistant_id values in assistant-scoped tables
 * to "self" so they are visible after the daemon switched to the implicit single-tenant
 * identity.
 *
 * Before this change, rows were keyed by the real assistantId string passed via the
 * HTTP route. After the route change, all lookups use the constant "self". Without this
 * migration an upgraded daemon would see empty history / attachment lists for existing
 * data that was stored under the old assistantId.
 *
 * Affected tables:
 *   - conversation_keys   UNIQUE (assistant_id, conversation_key)
 *   - attachments         UNIQUE (assistant_id, content_hash) WHERE content_hash IS NOT NULL
 *   - channel_inbound_events  UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
 *   - message_runs        no unique constraint on assistant_id
 *
 * Data-safety guarantees:
 *   - conversation_keys: when a key exists under both 'self' and a real assistantId, the
 *     'self' row is updated to point to the real-assistantId conversation (which holds the
 *     historical message thread). The 'self' conversation may be orphaned but is not deleted.
 *   - attachments: message_attachments links are remapped to the surviving attachment before
 *     any duplicate row is deleted, so no message loses its attachment metadata.
 *   - channel_inbound_events: only delivery-tracking metadata, not user content; dedup
 *     keeps one row per unique (channel, chat, message) tuple.
 *   - All conversations and messages remain untouched — only assistant_id index columns
 *     and key-lookup rows are modified.
 */
export function migrateAssistantIdToSelf(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_normalize_assistant_id_to_self_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // On fresh installs the tables are created without assistant_id (PR 7+). Skip the
  // migration if NONE of the four affected tables have the column — pre-seed the
  // checkpoint so subsequent startups are also skipped. Checking all four (not just
  // conversation_keys) avoids a false negative on very old installs where
  // conversation_keys may not exist yet but other tables still carry assistant_id data.
  const affectedTables = [
    "conversation_keys",
    "attachments",
    "channel_inbound_events",
    "message_runs",
  ];
  const anyHasAssistantId = affectedTables.some((tbl) => {
    const ddl = raw
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tbl) as { sql: string } | null;
    return ddl?.sql.includes("assistant_id") ?? false;
  });
  if (!anyHasAssistantId) {
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  // Helper: returns true if the given table's current DDL contains 'assistant_id'.
  const tableHasAssistantId = (tbl: string): boolean => {
    const ddl = raw
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tbl) as { sql: string } | null;
    return ddl?.sql.includes("assistant_id") ?? false;
  };

  try {
    raw.exec("BEGIN");

    // Each section is guarded so that SQL referencing assistant_id is only executed
    // when the column still exists in that table. This handles mixed-schema states
    // (e.g., very old installs where some tables may already lack the column).

    // conversation_keys: UNIQUE (assistant_id, conversation_key)
    if (tableHasAssistantId("conversation_keys")) {
      // Step 1: Among non-self rows, keep only one per conversation_key so the
      //         bulk UPDATE cannot hit a (non-self-A, key) + (non-self-B, key) collision.
      raw.exec(/*sql*/ `
        DELETE FROM conversation_keys
        WHERE assistant_id != 'self'
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM conversation_keys
            WHERE assistant_id != 'self'
            GROUP BY conversation_key
          )
      `);
      // Step 2: For 'self' rows that have a non-self counterpart with the same
      //         conversation_key, update the 'self' row to use the non-self row's
      //         conversation_id. This preserves the historical conversation (which
      //         has the message history from before the route change) rather than
      //         discarding it in favour of a potentially-empty 'self' conversation.
      raw.exec(/*sql*/ `
        UPDATE conversation_keys
        SET conversation_id = (
          SELECT ck_ns.conversation_id
          FROM conversation_keys ck_ns
          WHERE ck_ns.assistant_id != 'self'
            AND ck_ns.conversation_key = conversation_keys.conversation_key
          ORDER BY ck_ns.rowid
          LIMIT 1
        )
        WHERE assistant_id = 'self'
          AND EXISTS (
            SELECT 1 FROM conversation_keys ck_ns
            WHERE ck_ns.assistant_id != 'self'
              AND ck_ns.conversation_key = conversation_keys.conversation_key
          )
      `);
      // Step 3: Delete the now-redundant non-self rows (their conversation_ids
      //         have been preserved in the 'self' rows above).
      raw.exec(/*sql*/ `
        DELETE FROM conversation_keys
        WHERE assistant_id != 'self'
          AND EXISTS (
            SELECT 1 FROM conversation_keys ck2
            WHERE ck2.assistant_id = 'self'
              AND ck2.conversation_key = conversation_keys.conversation_key
          )
      `);
      // Step 4: Remaining non-self rows have no 'self' counterpart — safe to bulk-update.
      raw.exec(/*sql*/ `
        UPDATE conversation_keys SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    // attachments: UNIQUE (assistant_id, content_hash) WHERE content_hash IS NOT NULL
    //
    // message_attachments rows reference attachment IDs with ON DELETE CASCADE, so we
    // must remap links to the surviving row BEFORE deleting duplicates to avoid
    // silently dropping attachment metadata from messages.
    if (tableHasAssistantId("attachments")) {
      // Step 1: Remap message_attachments from non-self duplicates to their survivor
      //         (MIN rowid per content_hash group), then delete the duplicates.
      raw.exec(/*sql*/ `
        UPDATE message_attachments
        SET attachment_id = (
          SELECT a_survivor.id
          FROM attachments a_survivor
          WHERE a_survivor.assistant_id != 'self'
            AND a_survivor.content_hash = (
              SELECT a_dup.content_hash FROM attachments a_dup
              WHERE a_dup.id = message_attachments.attachment_id
            )
          ORDER BY a_survivor.rowid
          LIMIT 1
        )
        WHERE attachment_id IN (
          SELECT id FROM attachments
          WHERE assistant_id != 'self'
            AND content_hash IS NOT NULL
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM attachments
              WHERE assistant_id != 'self' AND content_hash IS NOT NULL
              GROUP BY content_hash
            )
        )
      `);
      raw.exec(/*sql*/ `
        DELETE FROM attachments
        WHERE assistant_id != 'self'
          AND content_hash IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM attachments
            WHERE assistant_id != 'self'
              AND content_hash IS NOT NULL
            GROUP BY content_hash
          )
      `);
      // Step 2: Remap message_attachments from non-self rows conflicting with a 'self'
      //         row to the 'self' row, then delete the now-unlinked non-self rows.
      raw.exec(/*sql*/ `
        UPDATE message_attachments
        SET attachment_id = (
          SELECT a_self.id
          FROM attachments a_self
          WHERE a_self.assistant_id = 'self'
            AND a_self.content_hash = (
              SELECT a_ns.content_hash FROM attachments a_ns
              WHERE a_ns.id = message_attachments.attachment_id
            )
          LIMIT 1
        )
        WHERE attachment_id IN (
          SELECT id FROM attachments
          WHERE assistant_id != 'self'
            AND content_hash IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM attachments a2
              WHERE a2.assistant_id = 'self'
                AND a2.content_hash = attachments.content_hash
            )
        )
      `);
      raw.exec(/*sql*/ `
        DELETE FROM attachments
        WHERE assistant_id != 'self'
          AND content_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM attachments a2
            WHERE a2.assistant_id = 'self'
              AND a2.content_hash = attachments.content_hash
          )
      `);
      // Step 3: Bulk-update remaining non-self rows.
      raw.exec(/*sql*/ `
        UPDATE attachments SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    // channel_inbound_events: UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
    if (tableHasAssistantId("channel_inbound_events")) {
      // Step 1: Dedup non-self rows sharing the same (source_channel, external_chat_id, external_message_id).
      raw.exec(/*sql*/ `
        DELETE FROM channel_inbound_events
        WHERE assistant_id != 'self'
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM channel_inbound_events
            WHERE assistant_id != 'self'
            GROUP BY source_channel, external_chat_id, external_message_id
          )
      `);
      // Step 2: Delete non-self rows conflicting with existing 'self' rows.
      raw.exec(/*sql*/ `
        DELETE FROM channel_inbound_events
        WHERE assistant_id != 'self'
          AND EXISTS (
            SELECT 1 FROM channel_inbound_events e2
            WHERE e2.assistant_id = 'self'
              AND e2.source_channel = channel_inbound_events.source_channel
              AND e2.external_chat_id = channel_inbound_events.external_chat_id
              AND e2.external_message_id = channel_inbound_events.external_message_id
          )
      `);
      // Step 3: Bulk-update remaining non-self rows.
      raw.exec(/*sql*/ `
        UPDATE channel_inbound_events SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    // message_runs: no unique constraint on assistant_id — simple bulk update
    if (tableHasAssistantId("message_runs")) {
      raw.exec(/*sql*/ `
        UPDATE message_runs SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
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
 * No-op down: the original assistant_id values are not recoverable. The forward
 * migration normalized all assistant_id values to "self" and merged/deduplicated
 * rows where the same logical entity existed under both the real assistantId and
 * "self". The original per-assistant IDs are permanently lost.
 */
export function downAssistantIdToSelf(_database: DrizzleDb): void {
  // Intentionally empty — original assistant_id values cannot be restored.
}
