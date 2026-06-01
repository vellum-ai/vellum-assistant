/**
 * `message_request_complete` SSE event.
 *
 * Request-level terminal signal for a user message lifecycle: the
 * runtime has finished handling this `requestId`. Unlike
 * `message_complete`, this does not imply the active assistant turn
 * has completed — it is used for paths that consume a request inline
 * while a separate in-flight turn may still be running.
 *
 * `runStillActive` is `true` when an existing turn is still running
 * after this request is finalized. Clients gate any "request settled"
 * UX on this flag rather than assuming the turn is done.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageRequestCompleteEventSchema = z.object({
  type: z.literal("message_request_complete"),
  conversationId: z.string(),
  requestId: z.string(),
  runStillActive: z.boolean().optional(),
});

export type MessageRequestCompleteEvent = z.infer<
  typeof MessageRequestCompleteEventSchema
>;
