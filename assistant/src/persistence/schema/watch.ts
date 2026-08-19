import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One entry in a watch session's timeline: what the user narrated, or what
 * was on their screen while they narrated it.
 *
 * The timeline is not conversation history. Entries are keyed by session and
 * ordered by `atMs`, the offset from the session's start, and only a rendered
 * summary reaches a model, composed by the retrospective that reads them.
 *
 * `screenshotAttachmentId` points at the attachments store rather than
 * carrying pixels, so a session's worth of frames stays out of the row.
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
  screenshotAttachmentId: text("screenshot_attachment_id"),
  createdAt: integer("created_at").notNull(),
});
