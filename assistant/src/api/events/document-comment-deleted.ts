/**
 * `document_comment_deleted` SSE event.
 *
 * Emitted when a document comment is removed. The client drops the
 * comment from local state.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const DocumentCommentDeletedEventSchema = z.object({
  type: z.literal("document_comment_deleted"),
  conversationId: z.string(),
  surfaceId: z.string(),
  commentId: z.string(),
});

export type DocumentCommentDeletedEvent = z.infer<
  typeof DocumentCommentDeletedEventSchema
>;
