/**
 * `assistant_text_delta` SSE event.
 *
 * Streaming text chunk emitted by the daemon as the model produces
 * assistant output. Multiple deltas accumulate into a single assistant
 * message; the matching `message_complete` event marks the turn done.
 *
 * `messageId` is the database row id of the assistant message this
 * delta belongs to — stamped from the pre-allocated turn anchor (see
 * `reserveMessage` / `AssistantTurnStartEvent`). Absent on streams
 * produced by older daemons that pre-date the anchor protocol, or on
 * synthetic deltas (canned greetings, slash-command echoes, live-voice
 * transcript injections) that don't bind to a row.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AssistantTextDeltaEventSchema = z
  .object({
    type: z.literal("assistant_text_delta"),
    text: z.string(),
    messageId: z.string().optional(),
    /** 0-based content-block index within the parent `messageId`. Optional
     *  for backwards compatibility with synthetic deltas that don't bind
     *  to a block. */
    blockIndex: z.number().optional(),
    /** Monotonically increasing per-conversation sequence number for
     *  idempotent client replay. Optional during the streaming-architecture
     *  rollout — daemons that pre-date PR 1 of the plan omit it. */
    seq: z.number().optional(),
    conversationId: z.string().optional(),
  })
  .strict();

export type AssistantTextDeltaEvent = z.infer<
  typeof AssistantTextDeltaEventSchema
>;
