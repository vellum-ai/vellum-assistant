/**
 * IPC route definitions for Slack active-thread listener control.
 *
 * The gateway owns Slack Socket Mode listener state, so assistant-side
 * controls call here instead of writing gateway storage directly.
 */

import { z } from "zod";

import { SlackStore } from "../db/slack-store.js";
import type { IpcRoute } from "./server.js";

let store: SlackStore | null = null;

function getStore(): SlackStore {
  if (!store) {
    store = new SlackStore();
  }
  return store;
}

const DetachSlackActiveThreadParamsSchema = z.object({
  channelId: z.string().trim().min(1),
  threadTs: z.string().trim().min(1),
});

export const slackThreadRoutes: IpcRoute[] = [
  {
    method: "detach_slack_active_thread",
    schema: DetachSlackActiveThreadParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channelId, threadTs } = DetachSlackActiveThreadParamsSchema.parse(
        params ?? {},
      );
      const detached = getStore().detachThread(threadTs, channelId);
      return { detached, channelId, threadTs };
    },
  },
];
