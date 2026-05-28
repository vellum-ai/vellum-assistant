/**
 * `assistant_text_delta` SSE event.
 *
 * Streaming text chunk emitted by the daemon as the model produces
 * assistant output. Multiple deltas accumulate into a single assistant
 * message; the matching `message_complete` event marks the turn done.
 *
 * `messageId` is the database row id of the assistant message this
 * delta belongs to. The main agent loop (post PR 1 of the
 * streaming-message-architecture plan) always allocates and emits a
 * `messageId` for every delta it produces, via `ensureMessageOpen` in
 * `conversation-agent-loop-handlers.ts`. The field stays optional in
 * this schema because synthetic emitters that don't bind to a persisted
 * row (canned greetings, slash-command echoes, live-voice transcript
 * injections, wake-target replays, recording handler echoes) still emit
 * deltas without one; those streams are consumed by channel adapters,
 * not by the `MessageStreamReducer` path.
 *
 * `blockIndex` and `seq` are populated whenever `messageId` is, so a
 * client receiving any of the three is guaranteed to receive all three
 * (idempotent reducer keying invariant — see `MessageStreamReducer`).
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
