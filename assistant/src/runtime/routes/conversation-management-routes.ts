/**
 * Route handlers for conversation management operations.
 *
 * POST   /v1/conversations                 — create a new conversation
 * POST   /v1/conversations/switch         — switch to an existing conversation
 * POST   /v1/conversations/fork           — fork an existing conversation
 * PUT    /v1/conversations/:id/inference-profile — set per-conversation inference profile
 * PATCH  /v1/conversations/:id/name       — rename a conversation
 * DELETE /v1/conversations                 — clear all conversations
 * POST   /v1/conversations/:id/wipe       — wipe conversation and revert memory
 * DELETE /v1/conversations/:id            — delete a single conversation
 * POST   /v1/conversations/:id/archive    — archive a conversation
 * POST   /v1/conversations/:id/unarchive  — restore an archived conversation
 * POST   /v1/conversations/:id/cancel     — cancel generation
 * POST   /v1/conversations/:id/undo       — undo last message
 * POST   /v1/conversations/:id/regenerate — regenerate last assistant response
 * POST   /v1/conversations/reorder        — reorder / pin conversations
 */

import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
import { destroyActiveConversation } from "../../daemon/conversation-store.js";
import {
  cancelGeneration,
  clearAllConversations,
  regenerateResponse,
  switchConversation,
  undoLastMessage,
} from "../../daemon/handlers/conversations.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { ConversationListInvalidatedReason } from "../../daemon/message-types/conversations.js";
import { normalizeConversationType } from "../../daemon/message-types/shared.js";
import {
  archiveConversation,
  batchSetDisplayOrders,
  countConversationsByScheduleJobId,
  deleteConversation,
  forkConversation as forkConversationInStore,
  getConversation,
  setConversationInferenceProfile,
  unarchiveConversation,
  updateConversationTitle,
  wipeConversation,
} from "../../memory/conversation-crud.js";
import {
  getOrCreateConversation,
  resolveConversationId,
  setConversationKeyIfAbsent,
} from "../../memory/conversation-key-store.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { deleteSchedule } from "../../schedule/schedule-store.js";
import { UserError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { buildConversationDetailResponse } from "../services/conversation-serializer.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-management-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrThrow(rawId: string): string {
  const id = resolveConversationId(rawId);
  if (!id) throw new NotFoundError(`Conversation ${rawId} not found`);
  return id;
}

function publishListInvalidated(reason: ConversationListInvalidatedReason): void {
  assistantEventHub
    .publish(
      buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
        type: "conversation_list_invalidated",
        reason,
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        `Failed to publish conversation_list_invalidated (${reason})`,
      );
    });
}

function cancelScheduleIfLast(conversationId: string): void {
  const conv = getConversation(conversationId);
  if (
    conv?.scheduleJobId &&
    countConversationsByScheduleJobId(conv.scheduleJobId) <= 1
  ) {
    deleteSchedule(conv.scheduleJobId);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleCreateConversation({ body = {} }: RouteHandlerArgs) {
  const conversationKey =
    (body.conversationKey as string | undefined) ?? crypto.randomUUID();
  const result = getOrCreateConversation(conversationKey, {
    conversationType: "standard",
  });
  if (result.created) {
    updateConversationTitle(result.conversationId, "New Conversation");
  }
  log.info(
    {
      conversationId: result.conversationId,
      conversationKey,
      created: result.created,
    },
    "Created conversation via POST",
  );
  return {
    id: result.conversationId,
    conversationKey,
    conversationType: normalizeConversationType(result.conversationType),
    created: result.created,
  };
}

async function handleForkConversation({ body = {} }: RouteHandlerArgs) {
  const conversationId = body.conversationId as string | undefined;
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("Missing conversationId");
  }
  if (
    body.throughMessageId !== undefined &&
    typeof body.throughMessageId !== "string"
  ) {
    throw new BadRequestError("throughMessageId must be a string");
  }

  const resolvedConversationId =
    resolveConversationId(conversationId) ?? conversationId;

  try {
    const forkedConversation = forkConversationInStore({
      conversationId: resolvedConversationId,
      throughMessageId: body.throughMessageId as string | undefined,
    });
    const detail = buildConversationDetailResponse(forkedConversation.id);
    if (!detail) {
      throw new InternalError(
        `Forked conversation ${forkedConversation.id} could not be loaded`,
      );
    }
    return { conversation: detail.conversation };
  } catch (err) {
    if (err instanceof UserError) {
      throw new NotFoundError(err.message);
    }
    throw err;
  }
}

async function handleSwitchConversation({ body = {} }: RouteHandlerArgs) {
  const conversationId = body.conversationId as string | undefined;
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("Missing conversationId");
  }
  const result = await switchConversation(conversationId);
  if (!result) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }
  if (body.conversationKey && typeof body.conversationKey === "string") {
    setConversationKeyIfAbsent(body.conversationKey, conversationId);
  }
  return {
    conversationId: result.conversationId,
    title: result.title,
    conversationType: normalizeConversationType(result.conversationType),
    ...(result.inferenceProfile != null
      ? { inferenceProfile: result.inferenceProfile }
      : {}),
  };
}

function handleSetInferenceProfile({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const resolvedId =
    resolveConversationId(pathParams.id!) ?? pathParams.id!;
  const conversation = getConversation(resolvedId);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }

  if (
    body.profile !== null &&
    (typeof body.profile !== "string" ||
      (body.profile as string).length === 0)
  ) {
    throw new BadRequestError(
      "profile must be a non-empty string or null",
    );
  }

  const profile = body.profile as string | null;
  if (profile !== null) {
    const profiles = loadConfig().llm?.profiles ?? {};
    if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
      throw new BadRequestError(
        `Profile "${profile}" is not defined in llm.profiles`,
      );
    }
  }

  if (conversation.inferenceProfile !== profile) {
    setConversationInferenceProfile(resolvedId, profile);
    assistantEventHub
      .publish(
        buildAssistantEvent(
          DAEMON_INTERNAL_ASSISTANT_ID,
          {
            type: "conversation_inference_profile_updated",
            conversationId: resolvedId,
            profile,
          },
          resolvedId,
        ),
      )
      .catch((err) => {
        log.warn(
          { err, conversationId: resolvedId },
          "Failed to publish conversation_inference_profile_updated event",
        );
      });
  }

  return { conversationId: resolvedId, profile };
}

function handleRenameConversation({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const name = body.name as string | undefined;
  if (!name || typeof name !== "string") {
    throw new BadRequestError("Missing name");
  }
  const conversation = getConversation(pathParams.id!);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  updateConversationTitle(pathParams.id!, name, 0);

  assistantEventHub
    .publish(
      buildAssistantEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        {
          type: "conversation_title_updated",
          conversationId: pathParams.id!,
          title: name,
        },
        pathParams.id!,
      ),
    )
    .catch((err) => {
      log.warn(
        { err, conversationId: pathParams.id },
        "Failed to publish conversation_title_updated",
      );
    });

  publishListInvalidated("renamed");

  return { ok: true };
}

function handleClearAllConversations({ headers = {} }: RouteHandlerArgs) {
  const confirm = headers["x-confirm-destructive"];
  if (confirm !== "clear-all-conversations") {
    throw new BadRequestError(
      "DELETE /v1/conversations permanently deletes ALL conversations, messages, and memory. " +
        "To confirm, set header X-Confirm-Destructive: clear-all-conversations",
    );
  }
  clearAllConversations();
  return undefined;
}

function handleWipeConversation({ pathParams = {} }: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);

  cancelScheduleIfLast(resolvedId);

  destroyActiveConversation(resolvedId);
  const result = wipeConversation(resolvedId);
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
  log.info(
    {
      conversationId: resolvedId,
      summariesDeleted: result.deletedSummaryIds.length,
      jobsCancelled: result.cancelledJobCount,
    },
    "Wiped conversation and reverted memory changes",
  );
  return {
    wiped: true,
    unsupersededItems: 0,
    deletedSummaries: result.deletedSummaryIds.length,
    cancelledJobs: result.cancelledJobCount,
  };
}

function handleDeleteConversation({ pathParams = {} }: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);

  cancelScheduleIfLast(resolvedId);

  destroyActiveConversation(resolvedId);
  const deleted = deleteConversation(resolvedId);
  for (const segId of deleted.segmentIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "segment",
      targetId: segId,
    });
  }
  for (const summaryId of deleted.deletedSummaryIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "summary",
      targetId: summaryId,
    });
  }
  log.info({ conversationId: resolvedId }, "Deleted conversation");

  publishListInvalidated("deleted");

  return undefined;
}

function handleArchiveConversation({ pathParams = {} }: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);
  const archived = archiveConversation(resolvedId);
  if (!archived) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  return { ok: true, conversationId: resolvedId };
}

function handleUnarchiveConversation({ pathParams = {} }: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);
  const unarchived = unarchiveConversation(resolvedId);
  if (!unarchived) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  return { ok: true, conversationId: resolvedId };
}

function handleCancelGeneration({ pathParams = {} }: RouteHandlerArgs) {
  const resolvedId = resolveConversationId(pathParams.id!) ?? pathParams.id!;
  cancelGeneration(resolvedId);
  return undefined;
}

async function handleUndoLastMessage({ pathParams = {} }: RouteHandlerArgs) {
  const result = await undoLastMessage(pathParams.id!);
  if (!result) {
    throw new NotFoundError(
      `No active conversation for ${pathParams.id}`,
    );
  }
  return {
    removedCount: result.removedCount,
    conversationId: pathParams.id!,
  };
}

async function handleRegenerateResponse({ pathParams = {} }: RouteHandlerArgs) {
  const conversationId = pathParams.id!;
  const resolvedId = resolveConversationId(conversationId) ?? conversationId;
  let hubChain: Promise<void> = Promise.resolve();
  const sendEvent = (event: ServerMessage) => {
    const ae = buildAssistantEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      event,
      resolvedId,
    );
    hubChain = (async () => {
      await hubChain;
      try {
        await assistantEventHub.publish(ae);
      } catch (err) {
        log.warn(
          { err },
          "assistant-events hub subscriber threw during regenerate",
        );
      }
    })();
  };
  try {
    const result = await regenerateResponse(conversationId, sendEvent);
    if (!result) {
      throw new NotFoundError(
        `No active conversation for ${pathParams.id}`,
      );
    }
    return undefined;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, conversationId: pathParams.id },
      "Error regenerating via HTTP",
    );
    throw new InternalError(`Failed to regenerate: ${message}`);
  }
}

function handleReorderConversations({ body = {} }: RouteHandlerArgs) {
  const updates = body.updates as
    | Array<{
        conversationId: string;
        displayOrder?: number;
        isPinned?: boolean;
        groupId?: string | null;
      }>
    | undefined;
  if (!Array.isArray(updates)) {
    throw new BadRequestError("Missing updates array");
  }
  batchSetDisplayOrders(
    updates.map((u) => ({
      id: u.conversationId,
      displayOrder: u.displayOrder ?? null,
      isPinned: u.isPinned ?? false,
      groupId: u.groupId,
    })),
  );
  publishListInvalidated("reordered");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "createConversation",
    endpoint: "conversations",
    method: "POST",
    policyKey: "conversations",
    summary: "Create a conversation",
    description: "Create or get an existing conversation by key.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationKey: z
        .string()
        .describe("Idempotency key for the conversation"),
      conversationType: z
        .literal("standard")
        .optional()
        .describe("Only standard conversations are created by this endpoint"),
    }),
    responseBody: z.object({
      id: z.string(),
      conversationKey: z.string(),
      conversationType: z.string(),
      created: z.boolean(),
    }),
    handler: handleCreateConversation,
  },
  {
    operationId: "forkConversation",
    endpoint: "conversations/fork",
    method: "POST",
    policyKey: "conversations/fork",
    summary: "Fork a conversation",
    description:
      "Create a copy of a conversation, optionally truncated at a specific message.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string(),
      throughMessageId: z
        .string()
        .describe("Truncate the fork at this message")
        .optional(),
    }),
    handler: handleForkConversation,
  },
  {
    operationId: "switchConversation",
    endpoint: "conversations/switch",
    method: "POST",
    policyKey: "conversations/switch",
    summary: "Switch active conversation",
    description: "Set the active conversation for the current session.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string(),
      conversationKey: z
        .string()
        .describe("Optional key to register for this conversation")
        .optional(),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      title: z.string(),
      conversationType: z.string(),
      inferenceProfile: z.string().optional(),
    }),
    handler: handleSwitchConversation,
  },
  {
    operationId: "setConversationInferenceProfile",
    endpoint: "conversations/:id/inference-profile",
    method: "PUT",
    policyKey: "conversations/inference-profile",
    summary: "Set conversation inference profile",
    description:
      "Override the LLM inference profile for a single conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      profile: z.string().nullable(),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      profile: z.string().nullable(),
    }),
    handler: handleSetInferenceProfile,
  },
  {
    operationId: "renameConversation",
    endpoint: "conversations/:id/name",
    method: "PATCH",
    policyKey: "conversations/name",
    summary: "Rename a conversation",
    description: "Update the display name of a conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      name: z.string(),
    }),
    handler: handleRenameConversation,
  },
  {
    operationId: "clearAllConversations",
    endpoint: "conversations",
    method: "DELETE",
    policyKey: "conversations/clear-all",
    summary: "Clear all conversations",
    description:
      "Permanently delete ALL conversations, messages, and memory.",
    tags: ["conversations"],
    responseStatus: "204",
    handler: handleClearAllConversations,
  },
  {
    operationId: "wipeConversation",
    endpoint: "conversations/:id/wipe",
    method: "POST",
    policyKey: "conversations/wipe",
    summary: "Wipe a conversation",
    description:
      "Delete all messages in a conversation and revert associated memory changes.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      wiped: z.boolean(),
      unsupersededItems: z.number().int(),
      deletedSummaries: z.number().int(),
      cancelledJobs: z.number().int(),
    }),
    handler: handleWipeConversation,
  },
  {
    operationId: "deleteConversation",
    endpoint: "conversations/:id",
    method: "DELETE",
    policyKey: "conversations",
    summary: "Delete a conversation",
    description: "Permanently delete a single conversation and its messages.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseStatus: "204",
    handler: handleDeleteConversation,
  },
  {
    operationId: "archiveConversation",
    endpoint: "conversations/:id/archive",
    method: "POST",
    policyKey: "conversations",
    summary: "Archive a conversation",
    description: "Move a conversation to the archived state.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    handler: handleArchiveConversation,
  },
  {
    operationId: "unarchiveConversation",
    endpoint: "conversations/:id/unarchive",
    method: "POST",
    policyKey: "conversations",
    summary: "Unarchive a conversation",
    description:
      "Restore an archived conversation back to the default sidebar.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    handler: handleUnarchiveConversation,
  },
  {
    operationId: "cancelConversationGeneration",
    endpoint: "conversations/:id/cancel",
    method: "POST",
    policyKey: "conversations/cancel",
    summary: "Cancel generation",
    description:
      "Abort the in-progress assistant response for a conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id" }],
    responseStatus: "202",
    handler: handleCancelGeneration,
  },
  {
    operationId: "undoLastMessage",
    endpoint: "conversations/:id/undo",
    method: "POST",
    policyKey: "conversations/undo",
    summary: "Undo last message",
    description:
      "Remove the most recent user+assistant message pair from the conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      removedCount: z.number().int(),
      conversationId: z.string(),
    }),
    handler: handleUndoLastMessage,
  },
  {
    operationId: "regenerateResponse",
    endpoint: "conversations/:id/regenerate",
    method: "POST",
    policyKey: "conversations/regenerate",
    summary: "Regenerate response",
    description:
      "Re-run the assistant for the last user message in a conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseStatus: "202",
    handler: handleRegenerateResponse,
  },
  {
    operationId: "reorderConversations",
    endpoint: "conversations/reorder",
    method: "POST",
    policyKey: "conversations/reorder",
    summary: "Reorder conversations",
    description:
      "Batch-update display order and pin state for conversations.",
    tags: ["conversations"],
    requestBody: z.object({
      updates: z
        .array(z.unknown())
        .describe(
          "Array of { conversationId, displayOrder?, isPinned? } objects",
        ),
    }),
    handler: handleReorderConversations,
  },
];
