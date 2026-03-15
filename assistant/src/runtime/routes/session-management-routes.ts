/**
 * Route handlers for session management operations.
 *
 * POST   /v1/conversations/switch         — switch to an existing conversation
 * PATCH  /v1/conversations/:id/name       — rename a conversation
 * DELETE /v1/conversations                 — clear all conversations
 * DELETE /v1/conversations/:id            — delete a single conversation
 * POST   /v1/conversations/:id/cancel     — cancel generation
 * POST   /v1/conversations/:id/undo       — undo last message
 * POST   /v1/conversations/:id/regenerate — regenerate last assistant response
 * POST   /v1/sessions/reorder             — reorder / pin sessions
 */

import {
  batchSetDisplayOrders,
  deleteConversation,
} from "../../memory/conversation-crud.js";
import {
  resolveConversationId,
  setConversationKeyIfAbsent,
} from "../../memory/conversation-key-store.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("session-management-routes");

// ---------------------------------------------------------------------------
// Dependency types — injected by the daemon at wiring time
// ---------------------------------------------------------------------------

export interface SessionManagementDeps {
  switchSession: (sessionId: string) => Promise<{
    sessionId: string;
    title: string;
    conversationType: string;
  } | null>;
  renameSession: (sessionId: string, name: string) => boolean;
  clearAllSessions: () => number;
  cancelGeneration: (sessionId: string) => boolean;
  /** Abort and dispose an active in-memory session (if any) before deletion. */
  destroySession: (sessionId: string) => void;
  undoLastMessage: (
    sessionId: string,
  ) => Promise<{ removedCount: number } | null>;
  regenerateResponse: (
    sessionId: string,
  ) => Promise<{ requestId: string } | null>;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function sessionManagementRouteDefinitions(
  deps: SessionManagementDeps,
): RouteDefinition[] {
  return [
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
        const result = await deps.switchSession(conversationId);
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
          sessionId: result.sessionId,
          title: result.title,
          threadType:
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
        const success = deps.renameSession(params.id, name);
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
        deps.clearAllSessions();
        return new Response(null, { status: 204 });
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
        // Tear down the in-memory session (abort + dispose) before removing
        // persistence so that a running agent loop doesn't write to a deleted
        // conversation row, tripping FK constraints.
        deps.destroySession(resolvedId);
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
        deps.cancelGeneration(params.id);
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
            `No active session for conversation ${params.id}`,
            404,
          );
        }
        return Response.json({
          removedCount: result.removedCount,
          sessionId: params.id,
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
              `No active session for conversation ${params.id}`,
              404,
            );
          }
          return new Response(null, { status: 202 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { err, sessionId: params.id },
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
      endpoint: "sessions/reorder",
      method: "POST",
      policyKey: "sessions/reorder",
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          updates?: Array<{
            sessionId: string;
            displayOrder?: number;
            isPinned?: boolean;
          }>;
        };
        if (!Array.isArray(body.updates)) {
          return httpError("BAD_REQUEST", "Missing updates array", 400);
        }
        batchSetDisplayOrders(
          body.updates.map((u) => ({
            id: u.sessionId,
            displayOrder: u.displayOrder ?? null,
            isPinned: u.isPinned ?? false,
          })),
        );
        return Response.json({ ok: true });
      },
    },
  ];
}
