/**
 * `block_open` SSE event.
 *
 * Emitted when a new content block within an assistant message starts —
 * paired with `block_close` at the block's end. Carries the message and
 * block coordinates that every block-scoped event (`assistant_text_delta`,
 * `tool_use_start`, `tool_input_delta`, `tool_result`) stamps in this turn.
 *
 * Block kinds today:
 *   - `text`     — a streamed text block opened on the first text delta
 *                  emitted after the previous block closed.
 *   - `tool_use` — a tool invocation; opened immediately before the
 *                  matching `tool_use_start` event and closed when the
 *                  corresponding `tool_result` arrives.
 *
 * `blockIndex` is 0-based and monotonically increases within a single
 * message; it never repeats across blocks in the same `messageId`.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const BlockOpenEventSchema = z
  .object({
    type: z.literal("block_open"),
    messageId: z.string(),
    blockIndex: z.number(),
    blockType: z.enum(["text", "tool_use"]),
    /** Tool name when `blockType` is `tool_use`; omitted otherwise. */
    toolName: z.string().optional(),
    /** Tool-use id when `blockType` is `tool_use`; omitted otherwise. */
    toolUseId: z.string().optional(),
    /** Monotonically increasing per-conversation sequence number. */
    seq: z.number(),
    conversationId: z.string().optional(),
  })
  .strict();

export type BlockOpenEvent = z.infer<typeof BlockOpenEventSchema>;
