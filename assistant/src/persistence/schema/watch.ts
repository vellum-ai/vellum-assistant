import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One entry in a watch session's timeline: what the user narrated, or what
 * was on their screen while they narrated it.
 *
 * The timeline is not conversation history. Entries are keyed by session and
 * ordered by `atMs`, the offset from the session's start, and only a rendered
 * summary reaches a model, composed by the retrospective that reads them.
 *
 * `screenshot` holds the frame itself, so the row is an entry's only home: one
 * row, one lifetime, one delete. Reads that do not want the pixels select the
 * other columns and leave this one alone.
 */
export const watchTimelineEntries = sqliteTable("watch_timeline_entries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  /** Milliseconds since the session started. */
  atMs: integer("at_ms").notNull(),
  /** `narration` or `observation`. */
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  axTree: text("ax_tree"),
  axDiff: text("ax_diff"),
  /** JPEG bytes of the screen at `atMs`, or NULL when none was kept. */
  screenshot: blob("screenshot", { mode: "buffer" }),
  createdAt: integer("created_at").notNull(),
});
