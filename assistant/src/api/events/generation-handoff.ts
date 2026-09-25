/**
 * `generation_handoff` SSE event.
 *
 * The daemon does not emit this event. The schema stays in the published
 * contract so clients that still handle it keep compiling, and so a client
 * talking to an older daemon can still parse it.
 *
 * On those older daemons it marked an assistant turn that finished by yielding
 * control to the next queued user message in the same conversation.
 * Functionally similar to `message_complete` (same attachment payload, same
 * `messageId` semantics), but told the client that another turn was about to
 * begin without an intervening idle state.
 *
 * `queuedCount` is the depth of the conversation's pending-message queue at
 * handoff time (not including the just-finished turn).
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { ModeSessionSchema } from "../mode-session.js";
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
  modeSession: ModeSessionSchema.optional(),
  attachments: z.array(AssistantOutboundAttachmentSchema).optional(),
  attachmentWarnings: z.array(z.string()).optional(),
  /** The default profile the Auto profile routed the finished turn to,
   *  mirroring `message_complete`, so a reply that hands off to a queued
   *  turn still gets its badge on the live row. */
  autoRoutedProfile: z.string().optional(),
});

export type GenerationHandoffEvent = z.infer<
  typeof GenerationHandoffEventSchema
>;
