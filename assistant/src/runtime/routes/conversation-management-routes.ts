/**
 * Route handlers for conversation management operations.
 *
 * POST   /v1/conversations/switch         — switch to an existing conversation
 * POST   /v1/conversations/fork           — fork an existing conversation
 * PATCH  /v1/conversations/:id/name       — rename a conversation
 * DELETE /v1/conversations                 — clear all conversations
 * POST   /v1/conversations/:id/wipe       — wipe conversation and revert memory
 * DELETE /v1/conversations/:id            — delete a single conversation
 * POST   /v1/conversations/:id/cancel     — cancel generation
 * POST   /v1/conversations/:id/undo       — undo last message
 * POST   /v1/conversations/:id/regenerate — regenerate last assistant response
 * POST   /v1/conversations/reorder        — reorder / pin conversations
 */

import {
  batchSetDisplayOrders,
  deleteConversation,
  PRIVATE_CONVERSATION_FORK_ERROR,
  wipeConversation,
} from "../../memory/conversation-crud.js";
import {
  resolveConversationId,
  setConversationKeyIfAbsent,
} from "../../memory/conversation-key-store.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { UserError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
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
      endpoint: "conversations/fork",
      method: "POST",
      policyKey: "conversations/fork",
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
        });
      },
    },
    {
      endpoint: "conversations/:id/name",
      method: "PATCH",
      policyKey: "conversations/name",
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
        return Response.json({ ok: true });
      },
    },
    {
      endpoint: "conversations",
      method: "DELETE",
      policyKey: "conversations",
      handler: () => {
        deps.clearAllConversations();
        return new Response(null, { status: 204 });
      },
    },
    {
      endpoint: "conversations/:id/wipe",
      method: "POST",
      policyKey: "conversations/wipe",
      handler: async ({ params }) => {
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
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
        for (const itemId of result.orphanedItemIds) {
          enqueueMemoryJob("delete_qdrant_vectors", {
            targetType: "item",
            targetId: itemId,
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
            unsuperseded: result.unsupersededItemIds.length,
            summariesDeleted: result.deletedSummaryIds.length,
            jobsCancelled: result.cancelledJobCount,
          },
          "Wiped conversation and reverted memory changes",
        );
        return Response.json({
          wiped: true,
          unsupersededItems: result.unsupersededItemIds.length,
          deletedSummaries: result.deletedSummaryIds.length,
          cancelledJobs: result.cancelledJobCount,
        });
      },
    },
    {
      endpoint: "conversations/:id",
      method: "DELETE",
      policyKey: "conversations",
      handler: async ({ params }) => {
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
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
        for (const itemId of deleted.orphanedItemIds) {
          enqueueMemoryJob("delete_qdrant_vectors", {
            targetType: "item",
            targetId: itemId,
          });
        }
        log.info({ conversationId: resolvedId }, "Deleted conversation");
        return new Response(null, { status: 204 });
      },
    },
    {
      endpoint: "conversations/:id/cancel",
      method: "POST",
      policyKey: "conversations/cancel",
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
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          updates?: Array<{
            conversationId: string;
            displayOrder?: number;
            isPinned?: boolean;
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
          })),
        );
        return Response.json({ ok: true });
      },
    },
  ];
}
