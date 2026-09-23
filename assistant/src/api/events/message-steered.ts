/**
 * `message_steered` SSE event.
 *
 * The daemon does not emit this event. The schema stays in the published
 * contract so clients that still handle it keep compiling, and so a client
 * talking to an older daemon can still parse it.
 *
 * On those older daemons it was a server → client notification that an
 * in-flight generation was steered by a follow-up user message. Scoped by
 * `conversationId` and `requestId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageSteeredEventSchema = z.object({
  type: z.literal("message_steered"),
  conversationId: z.string(),
  requestId: z.string(),
});

export type MessageSteeredEvent = z.infer<typeof MessageSteeredEventSchema>;
