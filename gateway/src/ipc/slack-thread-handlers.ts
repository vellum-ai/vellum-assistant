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
export const DEFAULT_SLACK_ACTIVE_THREAD_TTL_MS = 24 * 60 * 60 * 1_000;

function getStore(): SlackStore {
  if (!store) {
    store = new SlackStore();
  }
  return store;
}

const SlackActiveThreadParamsSchema = z.object({
  channelId: z.string().trim().min(1),
  threadTs: z.string().trim().min(1),
});

const DetachSlackActiveThreadParamsSchema = SlackActiveThreadParamsSchema;

const TrackSlackActiveThreadParamsSchema = SlackActiveThreadParamsSchema.extend({
  ttlMs: z.number().int().positive().optional(),
});

export const slackThreadRoutes: IpcRoute[] = [
  {
    method: "track_slack_active_thread",
    schema: TrackSlackActiveThreadParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channelId, threadTs, ttlMs } =
        TrackSlackActiveThreadParamsSchema.parse(params ?? {});
      const effectiveTtlMs = ttlMs ?? DEFAULT_SLACK_ACTIVE_THREAD_TTL_MS;
      getStore().trackThread(threadTs, channelId, effectiveTtlMs);
      return {
        tracked: true,
        channelId,
        threadTs,
        ttlMs: effectiveTtlMs,
      };
    },
  },
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
