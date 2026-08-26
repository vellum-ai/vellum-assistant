/**
 * `feed_toast` SSE event.
 *
 * Emitted when a feed row lands in Needs you or Worth knowing: async work that
 * finished and wants attention while the user happens to be in the app.
 *
 * The daemon decides *what* is toast-worthy; the client decides *whether* to
 * draw one. A toast is in-app only, so a client whose window is not focused
 * drops the event and lets the system notification take over. That split is
 * deliberate: focus is a client fact the daemon cannot observe, and a daemon
 * that guessed would either double up with the banner or show nothing.
 *
 * Every toast has a durable feed row behind it (`feedItemId`), so a dropped
 * one costs the user nothing.
 *
 * Global event (no `conversationId`): the feed is per-user, not
 * per-conversation.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { FeedItemBucketSchema } from "../responses/home.js";

export const FeedToastEventSchema = z.object({
  type: z.literal("feed_toast"),
  /** Feed row this toast stands for. Read state lives there, not on the toast. */
  feedItemId: z.string(),
  bucket: FeedItemBucketSchema,
  title: z.string(),
  body: z.string(),
  /** Conversation to open when the toast is clicked. */
  conversationId: z.string().optional(),
  /** Inline action, so a needs-you toast can be answered without opening anything. */
  actionLabel: z.string().optional(),
  /** In-app route the inline action navigates to. */
  actionPath: z.string().optional(),
  /** ISO-8601 emit time, so a client can drop a toast it receives late. */
  emittedAt: z.string(),
});

export type FeedToastEvent = z.infer<typeof FeedToastEventSchema>;
