/**
 * HTTP route definitions for model configuration, conversation search,
 * message content, LLM context inspection, and queued message deletion.
 *
 * These routes expose conversation query functionality over the HTTP API.
 *
 * GET    /v1/model                      — current model info
 * PUT    /v1/model                      — set model
 * PUT    /v1/model/image-gen            — set image-gen model
 * GET    /v1/conversations/search       — search conversations
 * GET    /v1/messages/:id/content       — full message content
 * GET    /v1/messages/:id/llm-context   — LLM request logs for a message
 * DELETE /v1/messages/queued/:id        — delete queued message
 */

import { VALID_INFERENCE_PROVIDERS } from "../../config/schemas/services.js";
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
import { getRequestLogsByMessageId } from "../../memory/llm-request-log-store.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { normalizeLlmContextPayloads } from "./llm-context-normalization.js";

const validProviderSet = new Set<string>(VALID_INFERENCE_PROVIDERS);

type LlmContextNormalizationResult = ReturnType<
  typeof normalizeLlmContextPayloads
>;

type LlmContextSummaryResponse = NonNullable<
  Omit<NonNullable<LlmContextNormalizationResult["summary"]>, "provider">
> & {
  provider: string;
};

type LlmContextRouteResult = Omit<LlmContextNormalizationResult, "summary"> & {
  summary?: LlmContextSummaryResponse;
};

function applyStoredProviderToLlmContextResult(
  normalized: LlmContextNormalizationResult,
  provider: string | null,
): LlmContextRouteResult {
  if (!provider) {
    return normalized as LlmContextRouteResult;
  }

  return {
    ...normalized,
    summary: normalized.summary
      ? { ...normalized.summary, provider }
      : { provider },
  };
}

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface ConversationQueryRouteDeps {
  /** Lazy factory for model set context (config reload suppression, conversation eviction). */
  getModelSetContext?: () => ModelSetContext;
  /** Lookup an active conversation by ID for queued message deletion. */
  findConversationForQueue?: (
    id: string,
  ) => { removeQueuedMessage(requestId: string): boolean } | undefined;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationQueryRouteDefinitions(
  deps: ConversationQueryRouteDeps = {},
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
        const body = (await req.json()) as {
          modelId?: string;
          provider?: string;
        };
        if (!body.modelId || typeof body.modelId !== "string") {
          return httpError(
            "BAD_REQUEST",
            "Missing required field: modelId",
            400,
          );
        }
        if (
          body.provider !== undefined &&
          (typeof body.provider !== "string" ||
            !validProviderSet.has(body.provider))
        ) {
          return httpError(
            "BAD_REQUEST",
            `Invalid provider "${body.provider}". Valid providers: ${[...validProviderSet].join(", ")}`,
            400,
          );
        }
        try {
          const info = await setModel(
            body.modelId,
            deps.getModelSetContext(),
            body.provider,
          );
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
        const conversationId = url.searchParams.get("conversationId");
        const result = getMessageContent(
          params.id,
          conversationId ?? undefined,
        );
        if (!result) {
          return httpError("NOT_FOUND", `Message ${params.id} not found`, 404);
        }
        return Response.json(result);
      },
    },

    // ── LLM context (request logs) for a message ───────────────────────
    {
      endpoint: "messages/:id/llm-context",
      method: "GET",
      policyKey: "messages/llm-context",
      handler: ({ params }) => {
        const messageId = params.id;
        if (!messageId) {
          return httpError("BAD_REQUEST", "message id is required", 400);
        }
        const logs = getRequestLogsByMessageId(messageId);
        return Response.json({
          messageId,
          logs: logs.map((log) => {
            let requestPayload: unknown;
            try {
              requestPayload = JSON.parse(log.requestPayload);
            } catch {
              requestPayload = log.requestPayload;
            }
            let responsePayload: unknown;
            try {
              responsePayload = JSON.parse(log.responsePayload);
            } catch {
              responsePayload = log.responsePayload;
            }
            const normalized = normalizeLlmContextPayloads({
              requestPayload,
              responsePayload,
              createdAt: log.createdAt,
            });
            const result = applyStoredProviderToLlmContextResult(
              normalized,
              log.provider,
            );
            return {
              id: log.id,
              requestPayload,
              responsePayload,
              createdAt: log.createdAt,
              ...result,
            };
          }),
        });
      },
    },

    // ── Delete queued message ─────────────────────────────────────────
    {
      endpoint: "messages/queued/:id",
      method: "DELETE",
      policyKey: "messages/queued",
      handler: ({ url, params }) => {
        if (!deps.findConversationForQueue) {
          return httpError(
            "INTERNAL_ERROR",
            "Queued message deletion not available",
            500,
          );
        }
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          return httpError(
            "BAD_REQUEST",
            "Missing required query parameter: conversationId",
            400,
          );
        }
        const result = deleteQueuedMessage(
          conversationId,
          params.id,
          deps.findConversationForQueue,
        );
        if (result.removed) {
          return Response.json({
            ok: true,
            conversationId,
            requestId: params.id,
          });
        }
        if (result.reason === "conversation_not_found") {
          return httpError("NOT_FOUND", "Conversation not found", 404);
        }
        return httpError("NOT_FOUND", "Queued message not found", 404);
      },
    },
  ];
}
