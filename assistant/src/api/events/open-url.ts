/**
 * `open_url` SSE event.
 *
 * Sent by the assistant when it wants the client to open a URL — OAuth
 * authorization popups, system-settings deep links, and browser hand-offs
 * from tool execution. The web client routes the URL through same-origin
 * detection, an OAuth popup, or `window.open`, depending on the URL shape.
 *
 * Canonical wire-contract source. Assistant code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 *
 * `conversationId` is optional: emit sites with a conversation context
 * (OAuth orchestrator, conversation-scoped tools) should set it on the
 * inner message; CLI signal-file broadcasts and other global flows omit
 * it. The parser never grafts the envelope-level routing key onto the
 * typed event — the schema is the contract.
 */

import { z } from "zod";

export const OpenUrlEventSchema = z.object({
  type: z.literal("open_url"),
  url: z.string().min(1),
  title: z.string().optional(),
  conversationId: z.string().optional(),
});

export type OpenUrlEvent = z.infer<typeof OpenUrlEventSchema>;
