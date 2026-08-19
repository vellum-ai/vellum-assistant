import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates `watch_timeline_entries`: the per-session record of what a watch
 * session's user narrated and what was on their screen.
 *
 * The table is the timeline's only home. Entries live outside conversation
 * message history, so nothing here participates in turn alternation or
 * provider-facing sanitization, and only the retrospective's rendered summary
 * reaches a model.
 *
 * `screenshot_attachment_id` holds the id of a row in `attachments`, so the
 * pixels stay on disk behind the attachment store rather than in this table.
 * Timeline rows and the screenshots they own are removed together by the
 * watch store's purge.
 *
 * The two indexes cover the two access paths: reads are scoped to one session
 * and ordered by offset, and purges are scoped to one conversation.
 *
 * Idempotent: `IF NOT EXISTS` on the table and both indexes.
 */
export function migrateCreateWatchTimelineEntries(db: DrizzleDb): void {
  const raw = getSqliteFrom(db);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS watch_timeline_entries (
      id                       TEXT PRIMARY KEY,
      session_id               TEXT NOT NULL,
      conversation_id          TEXT NOT NULL,
      at_ms                    INTEGER NOT NULL,
      kind                     TEXT NOT NULL,
      text                     TEXT NOT NULL,
      ax_tree                  TEXT,
      ax_diff                  TEXT,
      screenshot_attachment_id TEXT,
      created_at               INTEGER NOT NULL
    )
  `);

  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_watch_timeline_entries_session ON watch_timeline_entries(session_id, at_ms)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_watch_timeline_entries_conversation ON watch_timeline_entries(conversation_id)`,
  );
}
