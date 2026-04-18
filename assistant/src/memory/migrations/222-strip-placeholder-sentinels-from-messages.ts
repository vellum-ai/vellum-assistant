import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Strip Anthropic provider placeholder sentinel text blocks from persisted
 * assistant messages.
 *
 * PLACEHOLDER_EMPTY_TURN and PLACEHOLDER_BLOCKS_OMITTED are injected into
 * outbound Anthropic request bodies to preserve role alternation when an
 * assistant turn would otherwise be empty. They are never supposed to be
 * persisted, but a leak path caused them to be stored in the messages table
 * where they render in chat bubbles as bold "PLACEHOLDER[...]" (markdown
 * interprets the double-underscore surround as bold).
 *
 * This migration walks every assistant message, parses its content blocks,
 * and drops text blocks whose text matches either sentinel (with or without
 * the null-byte prefix, to cover rows that round-tripped through tools that
 * stripped null bytes). If stripping leaves the message empty, stores [].
 *
 * Idempotent — safe to re-run.
 */
export function migrateStripPlaceholderSentinelsFromMessages(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_strip_placeholder_sentinels_from_messages_v1",
    () => {
      const raw = getSqliteFrom(database);

      const BATCH_SIZE = 100;
      let lastRowid = 0;

      for (;;) {
        const rows = raw
          .query(
            `SELECT rowid, id, content FROM messages
             WHERE role = 'assistant'
               AND content LIKE '%__PLACEHOLDER__%'
               AND rowid > ?
             ORDER BY rowid
             LIMIT ?`,
          )
          .all(lastRowid, BATCH_SIZE) as Array<{
          rowid: number;
          id: string;
          content: string;
        }>;

        if (rows.length === 0) break;

        for (const row of rows) {
          lastRowid = row.rowid;

          let blocks: Array<Record<string, unknown>>;
          try {
            const parsed = JSON.parse(row.content);
            if (!Array.isArray(parsed)) continue;
            blocks = parsed;
          } catch {
            continue;
          }

          const stripped = blocks.filter((b) => {
            if (b.type !== "text") return true;
            const text = typeof b.text === "string" ? b.text : "";
            return !isSentinelText(text);
          });

          if (stripped.length === blocks.length) continue;

          raw
            .query(`UPDATE messages SET content = ? WHERE id = ?`)
            .run(JSON.stringify(stripped), row.id);
        }
      }
    },
  );
}

function isSentinelText(text: string): boolean {
  const normalized = text.startsWith("\x00") ? text.slice(1) : text;
  return (
    normalized === "__PLACEHOLDER__[empty assistant turn]" ||
    normalized === "__PLACEHOLDER__[internal blocks omitted]"
  );
}
