/**
 * `block_close` SSE event.
 *
 * Emitted when a content block within an assistant message ends — the
 * peer of `block_open`. Text blocks close when the next non-text content
 * starts (or when the turn ends); tool_use blocks close when their
 * matching `tool_result` arrives. Clients should treat `(messageId,
 * blockIndex)` as the block identity for idempotent application.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const BlockCloseEventSchema = z
  .object({
    type: z.literal("block_close"),
    messageId: z.string(),
    blockIndex: z.number(),
    /** Monotonically increasing per-conversation sequence number. */
    seq: z.number(),
    conversationId: z.string().optional(),
  })
  .strict();

export type BlockCloseEvent = z.infer<typeof BlockCloseEventSchema>;
