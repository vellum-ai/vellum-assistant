/**
 * `message_close` SSE event.
 *
 * Emitted at the end of an assistant turn — the peer of `message_open`,
 * carrying the same `messageId`. Marks the turn done in the new
 * streaming architecture; the legacy `message_complete` event continues
 * to fire alongside it during the rollout for backward compatibility.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageCloseEventSchema = z
  .object({
    type: z.literal("message_close"),
    messageId: z.string(),
    /** Monotonically increasing per-conversation sequence number. */
    seq: z.number(),
    conversationId: z.string().optional(),
  })
  .strict();

export type MessageCloseEvent = z.infer<typeof MessageCloseEventSchema>;
