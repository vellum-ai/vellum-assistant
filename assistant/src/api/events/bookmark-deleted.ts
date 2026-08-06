/**
 * `bookmark.deleted` SSE event.
 *
 * Server → client broadcast emitted after a bookmark is removed, so a
 * `BookmarkStore` in any other connected client drops it in lock-step.
 * Identifies the bookmark by the `messageId` it was anchored to.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const BookmarkDeletedEventSchema = z.object({
  type: z.literal("bookmark.deleted"),
  messageId: z.string(),
});

export type BookmarkDeletedEvent = z.infer<typeof BookmarkDeletedEventSchema>;
