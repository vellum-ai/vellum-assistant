/**
 * HTTP route definitions for model configuration, conversation search,
 * message content, and queued message deletion.
 *
 * These routes expose session query functionality over the HTTP API.
 *
 * GET    /v1/model                   — current model info
 * PUT    /v1/model                   — set model
 * PUT    /v1/model/image-gen         — set image-gen model
 * GET    /v1/conversations/search    — search conversations
 * GET    /v1/messages/:id/content    — full message content
 * DELETE /v1/messages/queued/:id     — delete queued message
 */

import {
  getModelInfo,
  type ModelSetContext,
  setImageGenModel,
  setModel,
} from "../../daemon/handlers/config-model.js";
import {
  getMessageContent,
  performConversationSearch,
} from "../../daemon/handlers/conversation-history.js";
import { deleteQueuedMessage } from "../../daemon/handlers/conversations.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface SessionQueryRouteDeps {
  /** Lazy factory for model set context (config reload suppression, session eviction). */
  getModelSetContext?: () => ModelSetContext;
  /** Lookup an active session by ID for queued message deletion. */
  findSessionForQueue?: (
    id: string,
  ) => { removeQueuedMessage(requestId: string): boolean } | undefined;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function sessionQueryRouteDefinitions(
  deps: SessionQueryRouteDeps = {},
): RouteDefinition[] {
  return [
    // ── Model config ──────────────────────────────────────────────────
    {
      endpoint: "model",
      method: "GET",
      policyKey: "model",
      handler: async () => {
        const info = await getModelInfo();
        return Response.json(info);
      },
    },
    {
      endpoint: "model",
      method: "PUT",
      policyKey: "model",
      handler: async ({ req }) => {
        if (!deps.getModelSetContext) {
          return httpError("INTERNAL_ERROR", "Model set not available", 500);
        }
        const body = (await req.json()) as { modelId?: string };
        if (!body.modelId || typeof body.modelId !== "string") {
          return httpError(
            "BAD_REQUEST",
            "Missing required field: modelId",
            400,
          );
        }
        try {
          const info = await setModel(body.modelId, deps.getModelSetContext());
          return Response.json(info);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return httpError(
            "INTERNAL_ERROR",
            `Failed to set model: ${message}`,
            500,
          );
        }
      },
    },
    {
      endpoint: "model/image-gen",
      method: "PUT",
      policyKey: "model/image-gen",
      handler: async ({ req }) => {
        if (!deps.getModelSetContext) {
          return httpError(
            "INTERNAL_ERROR",
            "Image gen model set not available",
            500,
          );
        }
        const body = (await req.json()) as { modelId?: string };
        if (!body.modelId || typeof body.modelId !== "string") {
          return httpError(
            "BAD_REQUEST",
            "Missing required field: modelId",
            400,
          );
        }
        try {
          setImageGenModel(body.modelId, deps.getModelSetContext());
          return Response.json({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return httpError(
            "INTERNAL_ERROR",
            `Failed to set image gen model: ${message}`,
            500,
          );
        }
      },
    },

    // ── Conversation search ───────────────────────────────────────────
    {
      endpoint: "conversations/search",
      method: "GET",
      policyKey: "conversations/search",
      handler: ({ url }) => {
        const q = url.searchParams.get("q");
        if (!q) {
          return httpError(
            "BAD_REQUEST",
            "Missing required query parameter: q",
            400,
          );
        }
        const limit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined;
        const maxMessages = url.searchParams.has("maxMessagesPerConversation")
          ? Number(url.searchParams.get("maxMessagesPerConversation"))
          : undefined;
        const results = performConversationSearch({
          query: q,
          limit,
          maxMessagesPerConversation: maxMessages,
        });
        return Response.json({ query: q, results });
      },
    },

    // ── Message content ───────────────────────────────────────────────
    {
      endpoint: "messages/:id/content",
      method: "GET",
      policyKey: "messages/content",
      handler: ({ url, params }) => {
        const sessionId = url.searchParams.get("sessionId");
        const result = getMessageContent(params.id, sessionId ?? undefined);
        if (!result) {
          return httpError("NOT_FOUND", `Message ${params.id} not found`, 404);
        }
        return Response.json(result);
      },
    },

    // ── Delete queued message ─────────────────────────────────────────
    {
      endpoint: "messages/queued/:id",
      method: "DELETE",
      policyKey: "messages/queued",
      handler: ({ url, params }) => {
        if (!deps.findSessionForQueue) {
          return httpError(
            "INTERNAL_ERROR",
            "Queued message deletion not available",
            500,
          );
        }
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          return httpError(
            "BAD_REQUEST",
            "Missing required query parameter: sessionId",
            400,
          );
        }
        const result = deleteQueuedMessage(
          sessionId,
          params.id,
          deps.findSessionForQueue,
        );
        if (result.removed) {
          return Response.json({
            ok: true,
            sessionId,
            requestId: params.id,
          });
        }
        if (result.reason === "session_not_found") {
          return httpError("NOT_FOUND", "Session not found", 404);
        }
        return httpError("NOT_FOUND", "Queued message not found", 404);
      },
    },
  ];
}
