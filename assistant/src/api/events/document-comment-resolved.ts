/**
 * `document_comment_resolved` SSE event.
 *
 * Emitted when an existing document comment is marked resolved. The
 * client transitions the comment's status to `"resolved"` and stamps
 * `resolvedBy` from the wire value.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const DocumentCommentResolvedEventSchema = z.object({
  type: z.literal("document_comment_resolved"),
  conversationId: z.string(),
  surfaceId: z.string(),
  commentId: z.string(),
  /** User or actor label that resolved the comment. */
  resolvedBy: z.string(),
});

export type DocumentCommentResolvedEvent = z.infer<
  typeof DocumentCommentResolvedEventSchema
>;
