/**
 * Transport-agnostic route for wiping a conversation.
 */

import { z } from "zod";

import {
  countConversationsByScheduleJobId,
  getConversation,
  wipeConversation,
} from "../../memory/conversation-crud.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { deleteSchedule } from "../../schedule/schedule-store.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Param schema ──────────────────────────────────────────────────────

const WipeConversationParams = z.object({
  conversationId: z.string().min(1),
});

// ── Daemon-owned dependency ───────────────────────────────────────────

let destroyConversation: ((conversationId: string) => void) | null = null;

export function registerDestroyConversation(
  fn: (conversationId: string) => void,
): void {
  destroyConversation = fn;
}

// ── Handler ───────────────────────────────────────────────────────────

async function handleWipeConversation({ body = {} }: RouteHandlerArgs) {
  if (!destroyConversation) {
    throw new BadRequestError(
      "wipe_conversation: destroyConversation not registered",
    );
  }

  const { conversationId } = WipeConversationParams.parse(body);

  const conv = getConversation(conversationId);
  if (!conv) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
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
}

// ── Response schema ───────────────────────────────────────────────────

const WipeConversationResponse = z.object({
  wiped: z.boolean(),
  unsupersededItems: z.number(),
  deletedSummaries: z.number(),
  cancelledJobs: z.number(),
});

// ── Route definition ──────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "wipe_conversation",
    endpoint: "conversations/wipe",
    method: "POST",
    handler: handleWipeConversation,
    summary: "Wipe a conversation",
    description:
      "Permanently delete a conversation and its associated data including memory vectors.",
    tags: ["conversations"],
    requestBody: WipeConversationParams,
    responseBody: WipeConversationResponse,
  },
];
