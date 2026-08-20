/**
 * `watch_retro_completed` SSE event.
 *
 * Server → client broadcast marking the end of a watch session's
 * retrospective, the turn `runWatchRetro` dispatches once the recording socket
 * is gone (`assistant/src/watch/watch-retro.ts`).
 *
 * **The watch stream cannot carry this.** A session's socket sends `closed`
 * and is torn down before the retro is dispatched, so by the time there is
 * anything to report the transport the user pressed stop on no longer exists.
 * Every client that draws a watch session is already subscribed to `/v1/events`
 * for the assistant, which is the one channel still open at that point.
 *
 * **Global, not conversation-scoped.** `conversationId` names the thread the
 * report was written into, which is a background conversation the user is
 * almost never sitting in: a session is narrated while working in another app
 * entirely. Clients route this by `sessionId` rather than against whichever
 * conversation they have open, the same way `notification_conversation_created`
 * announces a conversation other than the active one.
 *
 * **Emitted on every outcome, including the empty ones.** A client that told
 * the user their session is being summarized has to be told when it is not
 * coming, or it draws a progress affordance over nothing until it gives up on
 * its own. `reportReady` is the whole of that distinction: true when the turn
 * left an account of the session behind and the conversation has been surfaced
 * for the user to open, false when the session recorded nothing or the turn
 * failed to produce a report.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const WatchRetroCompletedEventSchema = z.object({
  type: z.literal("watch_retro_completed"),
  /**
   * The watch session the retrospective was run for, as the `ready` frame on
   * the watch stream named it. Clients match on this rather than on the
   * conversation, because a session can be started against a conversation it
   * did not mint and two sessions can therefore share one.
   */
  sessionId: z.string(),
  /** The conversation holding the report, and the one to open on a yes. */
  conversationId: z.string(),
  /** Whether there is a report in that conversation to read. */
  reportReady: z.boolean(),
});

export type WatchRetroCompletedEvent = z.infer<
  typeof WatchRetroCompletedEventSchema
>;
