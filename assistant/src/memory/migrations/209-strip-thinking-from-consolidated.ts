import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Strip thinking and redacted_thinking blocks from all assistant messages.
 *
 * Consolidated messages merge thinking blocks from different API responses,
 * making their cryptographic signatures invalid. Previously the Anthropic
 * provider stripped these on every request, mutating the conversation prefix
 * and defeating prompt caching. This migration cleans them at rest so the
 * provider no longer needs to strip, enabling append-only conversation
 * history and stable prefix caching.
 *
 * Idempotent — safe to re-run.
 */
export function migrateStripThinkingFromConsolidated(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_strip_thinking_from_consolidated_v1",
    () => {
      const raw = getSqliteFrom(database);

      const BATCH_SIZE = 100;
      let lastRowid = 0;

      for (;;) {
        const rows = raw
          .query(
            `SELECT rowid, id, content FROM messages
             WHERE role = 'assistant'
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

          let blocks: Array<{ type: string }>;
          try {
            const parsed = JSON.parse(row.content);
            if (!Array.isArray(parsed)) continue;
            blocks = parsed;
          } catch {
            continue;
          }

          const hasThinking = blocks.some(
            (b) => b.type === "thinking" || b.type === "redacted_thinking",
          );
          if (!hasThinking) continue;

          const stripped = blocks.filter(
            (b) => b.type !== "thinking" && b.type !== "redacted_thinking",
          );

          // Preserve at least one block so the message isn't empty.
          const finalContent =
            stripped.length > 0
              ? stripped
              : [
                  {
                    type: "text" as const,
                    text: "\x00__PLACEHOLDER__[internal blocks omitted]",
                  },
                ];

          raw
            .query(`UPDATE messages SET content = ? WHERE id = ?`)
            .run(JSON.stringify(finalContent), row.id);
        }
      }
    },
  );
}
