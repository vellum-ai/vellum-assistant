/**
 * `document_comment_created` SSE event.
 *
 * Emitted when a new comment is added to a document surface — either
 * authored by the user or by the assistant during a tool run. Carries
 * the full comment payload so the client can render it without a
 * separate fetch. Subsequent lifecycle transitions (resolve / reopen /
 * delete) reference the comment by id only.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

const DocumentCommentSchema = z.object({
  id: z.string(),
  surfaceId: z.string(),
  /** Author label — typically `"user"` or `"assistant"`. Wire is permissive `string`; clients narrow at the boundary. */
  author: z.string(),
  content: z.string(),
  /** Character offsets into the rendered document text when the comment is anchored to a selection. */
  anchorStart: z.number().optional(),
  anchorEnd: z.number().optional(),
  /** The selected text the comment was anchored to, for resilience to document edits. */
  anchorText: z.string().optional(),
  /** Set when the comment is a reply in a thread. */
  parentCommentId: z.string().optional(),
  /** Lifecycle state — `"open"` or `"resolved"`. Wire is permissive `string`; clients narrow at the boundary. */
  status: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const DocumentCommentCreatedEventSchema = z.object({
  type: z.literal("document_comment_created"),
  conversationId: z.string(),
  surfaceId: z.string(),
  comment: DocumentCommentSchema,
});

export type DocumentCommentCreatedEvent = z.infer<
  typeof DocumentCommentCreatedEventSchema
>;
