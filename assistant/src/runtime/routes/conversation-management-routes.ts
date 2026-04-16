/**
 * Route handlers for conversation management operations.
 *
 * POST   /v1/conversations                 — create a new conversation
 * POST   /v1/conversations/switch         — switch to an existing conversation
 * POST   /v1/conversations/fork           — fork an existing conversation
 * GET    /v1/conversations/:id/host-access — read host access for one conversation
 * PATCH  /v1/conversations/:id/host-access — update host access for one conversation
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

import {
  archiveConversation,
  batchSetDisplayOrders,
  countConversationsByScheduleJobId,
  deleteConversation,
  getConversation,
  getConversationHostAccess,
  PRIVATE_CONVERSATION_FORK_ERROR,
  unarchiveConversation,
  updateConversationHostAccess,
  wipeConversation,
} from "../../memory/conversation-crud.js";
import { updateConversationTitle } from "../../memory/conversation-crud.js";
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
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("conversation-management-routes");

// ---------------------------------------------------------------------------
// Dependency types — injected by the daemon at wiring time
// ---------------------------------------------------------------------------

export interface ConversationManagementDeps {
  forkConversation?: (params: {
    conversationId: string;
    throughMessageId?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  switchConversation: (conversationId: string) => Promise<{
    conversationId: string;
    title: string;
    conversationType: string;
    hostAccess: boolean;
  } | null>;
  renameConversation: (conversationId: string, name: string) => boolean;
  clearAllConversations: () => number;
  cancelGeneration: (conversationId: string) => boolean;
  /** Abort and dispose an active in-memory conversation (if any) before deletion. */
  destroyConversation: (conversationId: string) => void;
  undoLastMessage: (
    conversationId: string,
  ) => Promise<{ removedCount: number } | null>;
  regenerateResponse: (
    conversationId: string,
  ) => Promise<{ requestId: string } | null>;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationManagementRouteDefinitions(
  deps: ConversationManagementDeps,
): RouteDefinition[] {
  return [
    {
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
          .string()
          .describe("'standard' (default) or 'private'"),
      }),
      responseBody: z.object({
        id: z.string(),
        conversationKey: z.string(),
        conversationType: z.string(),
      }),
      handler: async ({ req }) => {
        let body: { conversationKey?: string; conversationType?: string } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          // Empty or malformed body — fall through with defaults.
        }
        const conversationKey = body.conversationKey ?? crypto.randomUUID();
        const requestedType =
          body.conversationType === "private" ? "private" : "standard";
        const result = getOrCreateConversation(conversationKey, {
          conversationType: requestedType,
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
        return Response.json(
          {
            id: result.conversationId,
            conversationKey,
            conversationType: result.conversationType,
          },
          { status: result.created ? 201 : 200 },
        );
      },
    },
    {
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
      handler: async ({ req }) => {
        if (!deps.forkConversation) {
          return httpError(
            "INTERNAL_ERROR",
            "Conversation forking not available",
            500,
          );
        }

        const rawBody = (await req.json()) as unknown;
        if (
          rawBody == null ||
          typeof rawBody !== "object" ||
          Array.isArray(rawBody)
        ) {
          return httpError("BAD_REQUEST", "Invalid request body", 400);
        }

        const body = rawBody as {
          conversationId?: string;
          throughMessageId?: string;
        };
        const conversationId = body.conversationId;
        if (!conversationId || typeof conversationId !== "string") {
          return httpError("BAD_REQUEST", "Missing conversationId", 400);
        }
        if (
          body.throughMessageId !== undefined &&
          typeof body.throughMessageId !== "string"
        ) {
          return httpError(
            "BAD_REQUEST",
            "throughMessageId must be a string",
            400,
          );
        }

        const resolvedConversationId =
          resolveConversationId(conversationId) ?? conversationId;

        try {
          const conversation = await deps.forkConversation({
            conversationId: resolvedConversationId,
            throughMessageId: body.throughMessageId,
          });
          return Response.json({ conversation });
        } catch (err) {
          if (err instanceof UserError) {
            if (err.message === PRIVATE_CONVERSATION_FORK_ERROR) {
              return httpError("FORBIDDEN", err.message, 403);
            }
            return httpError("NOT_FOUND", err.message, 404);
          }
          throw err;
        }
      },
    },
    {
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
        hostAccess: z.boolean(),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          conversationId?: string;
          conversationKey?: string;
        };
        const conversationId = body.conversationId;
        if (!conversationId || typeof conversationId !== "string") {
          return httpError("BAD_REQUEST", "Missing conversationId", 400);
        }
        const result = await deps.switchConversation(conversationId);
        if (!result) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${conversationId} not found`,
            404,
          );
        }
        // Register the conversation key mapping so the client can use it
        // for SSE subscriptions and message endpoints after switching.
        if (body.conversationKey && typeof body.conversationKey === "string") {
          setConversationKeyIfAbsent(body.conversationKey, conversationId);
        }
        return Response.json({
          conversationId: result.conversationId,
          title: result.title,
          conversationType:
            result.conversationType === "private" ? "private" : "standard",
          hostAccess: result.hostAccess,
        });
      },
    },
    {
      endpoint: "conversations/:id/host-access",
      method: "GET",
      policyKey: "conversations/host-access:GET",
      summary: "Get conversation host access",
      description: "Return whether the conversation can use host tools.",
      tags: ["conversations"],
      responseBody: z.object({
        conversationId: z.string(),
        hostAccess: z.boolean(),
      }),
      handler: ({ params }) => {
        const resolvedId = resolveConversationId(params.id) ?? params.id;
        const conversation = getConversation(resolvedId);
        if (!conversation) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }
        return Response.json({
          conversationId: conversation.id,
          hostAccess: getConversationHostAccess(conversation.id),
        });
      },
    },
    {
      endpoint: "conversations/:id/host-access",
      method: "PATCH",
      policyKey: "conversations/host-access",
      summary: "Update conversation host access",
      description: "Enable or disable host access for a conversation.",
      tags: ["conversations"],
      requestBody: z.object({
        hostAccess: z.boolean(),
      }),
      responseBody: z.object({
        conversationId: z.string(),
        hostAccess: z.boolean(),
      }),
      handler: async ({ req, params, authContext }) => {
        const guardianError = requireBoundGuardian(authContext);
        if (guardianError) return guardianError;

        const rawBody = (await req.json()) as unknown;
        if (
          rawBody == null ||
          typeof rawBody !== "object" ||
          Array.isArray(rawBody)
        ) {
          return httpError("BAD_REQUEST", "Invalid request body", 400);
        }
        const body = rawBody as { hostAccess?: unknown };
        if (typeof body.hostAccess !== "boolean") {
          return httpError("BAD_REQUEST", "Missing hostAccess boolean", 400);
        }

        const resolvedId = resolveConversationId(params.id) ?? params.id;
        const conversation = getConversation(resolvedId);
        if (!conversation) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }

        const nextHostAccess = body.hostAccess;
        if (conversation.hostAccess !== (nextHostAccess ? 1 : 0)) {
          updateConversationHostAccess(resolvedId, nextHostAccess);
          assistantEventHub
            .publish(
              buildAssistantEvent(
                DAEMON_INTERNAL_ASSISTANT_ID,
                {
                  type: "conversation_host_access_updated",
                  conversationId: resolvedId,
                  hostAccess: nextHostAccess,
                },
                resolvedId,
              ),
            )
            .catch((err) => {
              log.warn(
                { err, conversationId: resolvedId },
                "Failed to publish conversation_host_access_updated event",
              );
            });
        }

        return Response.json({
          conversationId: resolvedId,
          hostAccess: nextHostAccess,
        });
      },
    },
    {
      endpoint: "conversations/:id/name",
      method: "PATCH",
      policyKey: "conversations/name",
      summary: "Rename a conversation",
      description: "Update the display name of a conversation.",
      tags: ["conversations"],
      requestBody: z.object({
        name: z.string(),
      }),
      handler: async ({ req, params }) => {
        const body = (await req.json()) as { name?: string };
        const name = body.name;
        if (!name || typeof name !== "string") {
          return httpError("BAD_REQUEST", "Missing name", 400);
        }
        const success = deps.renameConversation(params.id, name);
        if (!success) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }

        // Broadcast conversation_title_updated so all connected clients
        // (including the one that initiated the rename) update immediately.
        assistantEventHub
          .publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
              type: "conversation_title_updated",
              conversationId: params.id,
              title: name,
            }),
          )
          .catch((err) => {
            log.warn(
              { err, conversationId: params.id },
              "Failed to publish conversation_title_updated",
            );
          });

        // Notify all connected clients that the conversation list changed
        // so sidebars on other devices can refresh.
        assistantEventHub
          .publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
              type: "conversation_list_invalidated",
              reason: "renamed",
            }),
          )
          .catch((err) => {
            log.warn(
              { err },
              "Failed to publish conversation_list_invalidated for rename",
            );
          });

        return Response.json({ ok: true });
      },
    },
    {
      endpoint: "conversations",
      method: "DELETE",
      policyKey: "conversations/clear-all",
      summary: "Clear all conversations",
      description:
        "Permanently delete ALL conversations, messages, and memory. Requires X-Confirm-Destructive header.",
      tags: ["conversations"],
      handler: ({ req }) => {
        const confirm = req.headers.get("x-confirm-destructive");
        if (confirm !== "clear-all-conversations") {
          return httpError(
            "BAD_REQUEST",
            "DELETE /v1/conversations permanently deletes ALL conversations, messages, and memory. " +
              "To confirm, set header X-Confirm-Destructive: clear-all-conversations",
            400,
          );
        }
        deps.clearAllConversations();
        return new Response(null, { status: 204 });
      },
    },
    {
      endpoint: "conversations/:id/wipe",
      method: "POST",
      policyKey: "conversations/wipe",
      summary: "Wipe a conversation",
      description:
        "Delete all messages in a conversation and revert associated memory changes.",
      tags: ["conversations"],
      responseBody: z.object({
        wiped: z.boolean(),
        unsupersededItems: z.number().int(),
        deletedSummaries: z.number().int(),
        cancelledJobs: z.number().int(),
      }),
      handler: async ({ params }) => {
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }

        // Cancel the associated schedule job (if any) before wiping the
        // conversation — but only when this is the last conversation that
        // references the schedule.  Recurring schedules create a new
        // conversation per run, so we must not cancel the schedule when
        // earlier run conversations are cleaned up.
        const conv = getConversation(resolvedId);
        if (
          conv?.scheduleJobId &&
          countConversationsByScheduleJobId(conv.scheduleJobId) <= 1
        ) {
          deleteSchedule(conv.scheduleJobId);
        }

        deps.destroyConversation(resolvedId);
        const result = wipeConversation(resolvedId);
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
        log.info(
          {
            conversationId: resolvedId,
            summariesDeleted: result.deletedSummaryIds.length,
            jobsCancelled: result.cancelledJobCount,
          },
          "Wiped conversation and reverted memory changes",
        );
        return Response.json({
          wiped: true,
          unsupersededItems: 0,
          deletedSummaries: result.deletedSummaryIds.length,
          cancelledJobs: result.cancelledJobCount,
        });
      },
    },
    {
      endpoint: "conversations/:id",
      method: "DELETE",
      policyKey: "conversations",
      summary: "Delete a conversation",
      description: "Permanently delete a single conversation and its messages.",
      tags: ["conversations"],
      handler: async ({ params }) => {
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }

        // Cancel the associated schedule job (if any) before deleting the
        // conversation — but only when this is the last conversation that
        // references the schedule.  Recurring schedules create a new
        // conversation per run, so we must not cancel the schedule when
        // earlier run conversations are cleaned up.
        const conv = getConversation(resolvedId);
        if (
          conv?.scheduleJobId &&
          countConversationsByScheduleJobId(conv.scheduleJobId) <= 1
        ) {
          deleteSchedule(conv.scheduleJobId);
        }

        // Tear down the in-memory conversation (abort + dispose) before removing
        // persistence so that a running agent loop doesn't write to a deleted
        // conversation row, tripping FK constraints.
        deps.destroyConversation(resolvedId);
        const deleted = deleteConversation(resolvedId);
        // Enqueue Qdrant vector cleanup jobs rather than calling directly.
        // Qdrant may not be initialized yet when the HTTP server starts
        // accepting requests, so enqueueing ensures cleanup is retried.
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

        // Notify all connected clients that the conversation list changed
        // so sidebars on other devices can refresh.
        assistantEventHub
          .publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
              type: "conversation_list_invalidated",
              reason: "deleted",
            }),
          )
          .catch((err) => {
            log.warn(
              { err },
              "Failed to publish conversation_list_invalidated for delete",
            );
          });

        return new Response(null, { status: 204 });
      },
    },
    {
      endpoint: "conversations/:id/archive",
      method: "POST",
      policyKey: "conversations",
      summary: "Archive a conversation",
      description:
        "Move a conversation to the archived state. Archived conversations are hidden from the default sidebar but preserved for search and recall.",
      tags: ["conversations"],
      handler: ({ params }) => {
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }
        const archived = archiveConversation(resolvedId);
        if (!archived) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }
        return Response.json({ ok: true, conversationId: resolvedId });
      },
    },
    {
      endpoint: "conversations/:id/unarchive",
      method: "POST",
      policyKey: "conversations",
      summary: "Unarchive a conversation",
      description:
        "Restore an archived conversation back to the default sidebar.",
      tags: ["conversations"],
      handler: ({ params }) => {
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }
        const unarchived = unarchiveConversation(resolvedId);
        if (!unarchived) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }
        return Response.json({ ok: true, conversationId: resolvedId });
      },
    },
    {
      endpoint: "conversations/:id/cancel",
      method: "POST",
      policyKey: "conversations/cancel",
      summary: "Cancel generation",
      description:
        "Abort the in-progress assistant response for a conversation.",
      tags: ["conversations"],
      handler: ({ params }) => {
        const resolvedId = resolveConversationId(params.id) ?? params.id;
        deps.cancelGeneration(resolvedId);
        return new Response(null, { status: 202 });
      },
    },
    {
      endpoint: "conversations/:id/undo",
      method: "POST",
      policyKey: "conversations/undo",
      summary: "Undo last message",
      description:
        "Remove the most recent user+assistant message pair from the conversation.",
      tags: ["conversations"],
      responseBody: z.object({
        removedCount: z.number().int(),
        conversationId: z.string(),
      }),
      handler: async ({ params }) => {
        const result = await deps.undoLastMessage(params.id);
        if (!result) {
          return httpError(
            "NOT_FOUND",
            `No active conversation for ${params.id}`,
            404,
          );
        }
        return Response.json({
          removedCount: result.removedCount,
          conversationId: params.id,
        });
      },
    },
    {
      endpoint: "conversations/:id/regenerate",
      method: "POST",
      policyKey: "conversations/regenerate",
      summary: "Regenerate response",
      description:
        "Re-run the assistant for the last user message in a conversation.",
      tags: ["conversations"],
      handler: async ({ params }) => {
        try {
          const result = await deps.regenerateResponse(params.id);
          if (!result) {
            return httpError(
              "NOT_FOUND",
              `No active conversation for ${params.id}`,
              404,
            );
          }
          return new Response(null, { status: 202 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { err, conversationId: params.id },
            "Error regenerating via HTTP",
          );
          return httpError(
            "INTERNAL_ERROR",
            `Failed to regenerate: ${message}`,
            500,
          );
        }
      },
    },
    {
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
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          updates?: Array<{
            conversationId: string;
            displayOrder?: number;
            isPinned?: boolean;
            groupId?: string | null;
          }>;
        };
        if (!Array.isArray(body.updates)) {
          return httpError("BAD_REQUEST", "Missing updates array", 400);
        }
        batchSetDisplayOrders(
          body.updates.map((u) => ({
            id: u.conversationId,
            displayOrder: u.displayOrder ?? null,
            isPinned: u.isPinned ?? false,
            groupId: u.groupId,
          })),
        );
        return Response.json({ ok: true });
      },
    },
  ];
}
