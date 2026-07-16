/**
 * `open_conversation` SSE event.
 *
 * Server push instructing the client to open (and, by default, focus) a
 * conversation. Emitted by the conversation launcher when a persistent
 * `ui_show` card fires a `launch_conversation` action, so the freshly
 * created conversation surfaces on the user's screen.
 *
 * Unlike most conversation-scoped events, `conversationId` here is the
 * **target** conversation to open — not the stream the event travelled on.
 * Clients must route it globally rather than gating it against the active
 * conversation.
 *
 * `focus` defaults to omitted (client-side default of `true`) so single-
 * target "jump to the new conversation" callers keep their existing
 * behavior. Fan-out launchers set `focus: false` to register the
 * conversation in the sidebar without stealing focus from the origin.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const OpenConversationEventSchema = z.object({
  type: z.literal("open_conversation"),
  conversationId: z.string(),
  title: z.string().optional(),
  anchorMessageId: z.string().optional(),
  focus: z.boolean().optional(),
});

export type OpenConversationEvent = z.infer<typeof OpenConversationEventSchema>;
