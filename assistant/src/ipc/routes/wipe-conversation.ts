import { z } from "zod";

import {
  countConversationsByScheduleJobId,
  getConversation,
  wipeConversation,
} from "../../memory/conversation-crud.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { deleteSchedule } from "../../schedule/schedule-store.js";
import type { IpcRoute } from "../assistant-server.js";

const WipeConversationParams = z.object({
  conversationId: z.string().min(1),
});

/**
 * Factory: returns a `wipe_conversation` IPC route that captures the
 * daemon-owned `destroyConversation` callback. The daemon registers this
 * at startup via `cliIpc.registerMethod(...)`.
 */
export function makeWipeConversationRoute(
  destroyConversation: (conversationId: string) => void,
): IpcRoute {
  return {
    method: "wipe_conversation",
    handler: async (params) => {
      const { conversationId } = WipeConversationParams.parse(params);

      const conv = getConversation(conversationId);
      if (!conv) {
        throw new Error(`Conversation ${conversationId} not found`);
      }

      // Cancel the associated schedule job (if any) before wiping —
      // but only when this is the last conversation for that schedule.
      if (
        conv.scheduleJobId &&
        countConversationsByScheduleJobId(conv.scheduleJobId) <= 1
      ) {
        deleteSchedule(conv.scheduleJobId);
      }

      destroyConversation(conversationId);
      const result = wipeConversation(conversationId);

      // Enqueue Qdrant vector cleanup jobs
      for (const segId of result.segmentIds) {
        enqueueMemoryJob("delete_qdrant_vectors", {
          targetType: "segment",
          targetId: segId,
        });
      }
      for (const summaryId of result.deletedSummaryIds) {
        enqueueMemoryJob("delete_qdrant_vectors", {
          targetType: "summary",
          targetId: summaryId,
        });
      }

      return {
        wiped: true,
        unsupersededItems: 0,
        deletedSummaries: result.deletedSummaryIds.length,
        cancelledJobs: result.cancelledJobCount,
      };
    },
  };
}
