/**
 * `message_open` SSE event.
 *
 * Emitted by the daemon on the first content emission of an assistant
 * turn — before the first `assistant_text_delta` or `tool_use_start` —
 * to declare a stable `messageId` (UUIDv7) for the message that the rest
 * of the turn's events will stamp on their `messageId` field. Paired with
 * `message_close` at end-of-turn. Clients should anchor a bubble at
 * `message_open` instead of inferring identity from the first delta.
 *
 * Additive alongside the legacy `assistant_text_delta` + `message_complete`
 * pair during the streaming-architecture rollout; new clients prefer the
 * `message_open` / `block_open` / `block_close` / `message_close` shape.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageOpenEventSchema = z
  .object({
    type: z.literal("message_open"),
    messageId: z.string(),
    role: z.enum(["assistant"]),
    /** Monotonically increasing per-conversation sequence number. */
    seq: z.number(),
    conversationId: z.string().optional(),
  })
  .strict();

export type MessageOpenEvent = z.infer<typeof MessageOpenEventSchema>;
