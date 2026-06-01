/**
 * `document_comment_reopened` SSE event.
 *
 * Emitted when a previously-resolved document comment is reopened.
 * The client clears the comment's resolved state and transitions it
 * back to `"open"`.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const DocumentCommentReopenedEventSchema = z.object({
  type: z.literal("document_comment_reopened"),
  conversationId: z.string(),
  surfaceId: z.string(),
  commentId: z.string(),
});

export type DocumentCommentReopenedEvent = z.infer<
  typeof DocumentCommentReopenedEventSchema
>;
