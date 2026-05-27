/**
 * `open_url` SSE event.
 *
 * Sent by the daemon when it wants the client to open a URL — OAuth
 * authorization popups, system-settings deep links, and browser hand-offs
 * from tool execution. The web client routes the URL through same-origin
 * detection, an OAuth popup, or `window.open`, depending on the URL shape.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 *
 * Conversation-scoping note: `conversationId` is the SSE routing key.
 * Daemon emit sites are not required to put it on the inner message —
 * the SSE pipe wraps each conversation-stream event in an envelope
 * `{ message, conversationId }`. The parser unwraps the envelope and,
 * on schema match, grafts `envelopeConversationId` onto the parsed
 * event when the inner didn't already declare one. The optional field
 * here documents that the parsed event carries this routing scope.
 */

import { z } from "zod";

export const OpenUrlEventSchema = z
  .object({
    type: z.literal("open_url"),
    url: z.string(),
    title: z.string().optional(),
    conversationId: z.string().optional(),
  })
  .strict();

export type OpenUrlEvent = z.infer<typeof OpenUrlEventSchema>;
