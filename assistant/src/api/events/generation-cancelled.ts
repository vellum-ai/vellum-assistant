/**
 * `generation_cancelled` SSE event.
 *
 * Emitted when an assistant turn is cancelled before completion —
 * user-initiated abort, queue-drain interruption, or daemon-side
 * lifecycle exit. Terminal event for the turn: no further deltas or
 * `message_complete` follow.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const GenerationCancelledEventSchema = z.object({
  type: z.literal("generation_cancelled"),
  conversationId: z.string().optional(),
});

export type GenerationCancelledEvent = z.infer<
  typeof GenerationCancelledEventSchema
>;
