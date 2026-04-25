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

// ---------------------------------------------------------------------------
// Daemon-owned dependency — set at startup via registerDestroyConversation()
// ---------------------------------------------------------------------------

let destroyConversation: ((conversationId: string) => void) | null = null;

export function registerDestroyConversation(
  fn: (conversationId: string) => void,
): void {
  destroyConversation = fn;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const wipeConversationRoute: IpcRoute = {
  method: "wipe_conversation",
  handler: async (params) => {
    if (!destroyConversation) {
      throw new Error("wipe_conversation: destroyConversation not registered");
    }

    const { conversationId } = WipeConversationParams.parse(params);

    const conv = getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (
      conv.scheduleJobId &&
      countConversationsByScheduleJobId(conv.scheduleJobId) <= 1
    ) {
      deleteSchedule(conv.scheduleJobId);
    }

    destroyConversation(conversationId);
    const result = wipeConversation(conversationId);

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
