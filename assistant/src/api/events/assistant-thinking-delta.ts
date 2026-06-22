/**
 * `assistant_thinking_delta` SSE event.
 *
 * Streaming reasoning chunk emitted by the daemon as a reasoning-capable
 * model produces its chain of thought. Multiple deltas accumulate into a
 * single assistant message's thinking block, interleaved with
 * `assistant_text_delta` and tool events in emission order; the matching
 * `message_complete` event marks the turn done.
 *
 * `messageId` is the database row id of the assistant message this
 * delta belongs to — same semantics as `AssistantTextDeltaEvent.messageId`.
 * Absent on streams produced by older daemons that pre-date the anchor
 * protocol.
 *
 * `timestampMs` is the daemon's wall-clock emission time for the delta. The
 * transport envelope (`AssistantEvent.emittedAt`) carries the same instant,
 * but it is dropped once the inner message is unwrapped for persistence,
 * debug buffers, and backend storage — so the timestamp is carried on the
 * payload itself to make per-delta timing observable wherever the message
 * travels.
 *
 * Only emitted when thinking streaming is enabled for the turn; turns that
 * suppress reasoning output produce none.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AssistantThinkingDeltaEventSchema = z.object({
  type: z.literal("assistant_thinking_delta"),
  thinking: z.string(),
  messageId: z.string().optional(),
  conversationId: z.string().optional(),
  /** Epoch milliseconds (`Date.now()`) at which the daemon emitted this
   *  delta. Absent on streams produced by daemons that pre-date this field. */
  timestampMs: z.number().optional(),
});

export type AssistantThinkingDeltaEvent = z.infer<
  typeof AssistantThinkingDeltaEventSchema
>;
