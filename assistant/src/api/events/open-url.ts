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
 * `conversationId` is the conversation this open_url belongs to. Emit sites
 * are responsible for setting it — the parser does not graft it from the
 * SSE envelope. CLI / global flows that don't belong to a conversation use
 * a separate signaling path.
 */

import { z } from "zod";

export const OpenUrlEventSchema = z
  .object({
    type: z.literal("open_url"),
    url: z.string().min(1),
    title: z.string().optional(),
    conversationId: z.string(),
  })
  .strict();

export type OpenUrlEvent = z.infer<typeof OpenUrlEventSchema>;
