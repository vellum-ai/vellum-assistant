import { isPlaceholderSentinelText } from "../../providers/placeholder-sentinels.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Strip provider placeholder sentinel text blocks from persisted assistant
 * messages.
 *
 * PLACEHOLDER_EMPTY_TURN and PLACEHOLDER_BLOCKS_OMITTED are injected into
 * outbound provider request bodies (Anthropic role alternation, OpenAI-
 * compatible "content or tool_calls" constraint) when an assistant turn would
 * otherwise be empty. They are never supposed to be
 * persisted, but a leak path caused them to be stored in the messages table
 * where they render in chat bubbles as bold "PLACEHOLDER[...]" (markdown
 * interprets the double-underscore surround as bold).
 *
 * This migration walks every assistant message, parses its content blocks,
 * and drops text blocks whose text matches either sentinel (with or without
 * the null-byte prefix, to cover rows that round-tripped through tools that
 * stripped null bytes). If stripping leaves the message empty, stores [].
 *
 * The `content LIKE '%__PLACEHOLDER__%'` predicate uses a leading wildcard, so
 * it can never ride an index — it costs one full scan of the assistant
 * messages regardless of how the rows are paged. That scan already narrows to
 * the (expected small) set of leaked rows, so the matches are collected in a
 * single pass and rewritten through one prepared statement inside one
 * transaction, rather than re-issuing the scan per batch and committing each
 * UPDATE on its own.
 *
 * Idempotent — safe to re-run.
 */
export function migrateStripPlaceholderSentinelsFromMessages(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const rows = raw
    .query(
      `SELECT id, content FROM messages
       WHERE role = 'assistant'
         AND content LIKE '%__PLACEHOLDER__%'`,
    )
    .all() as Array<{ id: string; content: string }>;
  if (rows.length === 0) return;

  const update = raw.prepare(`UPDATE messages SET content = ? WHERE id = ?`);

  const apply = raw.transaction(() => {
    for (const row of rows) {
      let blocks: Array<Record<string, unknown>>;
      try {
        const parsed = JSON.parse(row.content);
        if (!Array.isArray(parsed)) continue;
        blocks = parsed;
      } catch {
        continue;
      }

      const stripped = blocks.filter((b) => {
        if (typeof b !== "object" || b === null) return false;
        if (b.type !== "text") return true;
        const text = typeof b.text === "string" ? b.text : "";
        return !isPlaceholderSentinelText(text);
      });

      if (stripped.length === blocks.length) continue;

      update.run(JSON.stringify(stripped), row.id);
    }
  });

  apply();
}
