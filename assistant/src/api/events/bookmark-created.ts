/**
 * `bookmark.created` SSE event.
 *
 * Server → client broadcast emitted after a bookmark is created, so a
 * `BookmarkStore` in any other connected client refreshes in lock-step.
 * Carries the full `BookmarkSummary` for the new bookmark.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/** Summary row for a saved message, as surfaced to clients. */
export const BookmarkSummarySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  conversationId: z.string(),
  conversationTitle: z.string().nullable(),
  messagePreview: z.string(),
  /** "user" | "assistant" — kept free-form so it round-trips raw. */
  messageRole: z.string(),
  /** Unix milliseconds. */
  messageCreatedAt: z.number(),
  /** Unix milliseconds. */
  createdAt: z.number(),
});

export type BookmarkSummary = z.infer<typeof BookmarkSummarySchema>;

export const BookmarkCreatedEventSchema = z.object({
  type: z.literal("bookmark.created"),
  bookmark: BookmarkSummarySchema,
});

export type BookmarkCreatedEvent = z.infer<typeof BookmarkCreatedEventSchema>;
