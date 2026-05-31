/**
 * `generation_handoff` SSE event.
 *
 * Emitted when an assistant turn finishes and the daemon's agent loop
 * yields control to the next queued user message in the same
 * conversation. Functionally similar to `message_complete` — same
 * attachment payload, same `messageId` semantics — but tells the
 * client that another turn is about to begin without an intervening
 * idle state, so the UI can keep the activity indicator on.
 *
 * `queuedCount` is the depth of the conversation's pending-message
 * queue at handoff time (not including the just-finished turn). Used
 * by the client to size queued-message UI affordances.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { AssistantOutboundAttachmentSchema } from "./assistant-outbound-attachment.js";

export const GenerationHandoffEventSchema = z.object({
  type: z.literal("generation_handoff"),
  conversationId: z.string().optional(),
  /** Daemon request id of the just-finished turn — correlates with
   *  the request id surfaced by the inbound user message. */
  requestId: z.string().optional(),
  /** Depth of the pending-message queue at handoff time. */
  queuedCount: z.number(),
  /** Database row id of the just-finished assistant turn. */
  messageId: z.string().optional(),
  attachments: z.array(AssistantOutboundAttachmentSchema).optional(),
  attachmentWarnings: z.array(z.string()).optional(),
});

export type GenerationHandoffEvent = z.infer<
  typeof GenerationHandoffEventSchema
>;
