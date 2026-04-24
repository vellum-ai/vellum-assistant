/**
 * IPC route for Slack thread tracking.
 *
 * The assistant calls `slack_track_thread` after sending a message to a
 * Slack thread so the gateway's socket-mode event filter knows to forward
 * follow-up replies (without @mention) in that thread.
 */

import { z } from "zod";

import type { IpcRoute } from "./server.js";

const SlackTrackThreadSchema = z.object({
  threadTs: z.string().min(1),
});

export type SlackThreadTracker = (threadTs: string) => void;

/**
 * Create IPC routes for Slack thread tracking.
 *
 * Accepts a callback that registers a thread as active in the gateway's
 * Slack store. The callback is evaluated at call time so it always uses
 * the current `SlackSocketModeClient` instance (which may be recreated
 * on credential changes).
 */
export function createSlackThreadRoutes(
  getTracker: () => SlackThreadTracker | null,
): IpcRoute[] {
  return [
    {
      method: "slack_track_thread",
      schema: SlackTrackThreadSchema,
      handler(params) {
        const { threadTs } = params as z.infer<typeof SlackTrackThreadSchema>;
        const tracker = getTracker();
        if (tracker) {
          tracker(threadTs);
        }
        return { ok: true };
      },
    },
  ];
}
