/**
 * HTTP route definitions for model configuration, embedding configuration,
 * conversation search, message content, LLM
 * context inspection, and queued message deletion.
 *
 * These routes expose conversation query functionality over the HTTP API.
 *
 * GET    /v1/model                      — current model info
 * PUT    /v1/model                      — set model
 * PUT    /v1/model/image-gen            — set image-gen model
 * GET    /v1/config/embeddings          — current embedding config
 * PUT    /v1/config/embeddings          — set embedding provider/model
 * GET    /v1/config                     — full raw workspace config
 * PATCH  /v1/config                     — deep-merge partial config
 * PUT    /v1/config/llm/profiles/:name  — replace an inference profile
 * GET    /v1/conversations/search       — search conversations
 * GET    /v1/messages/:id/content       — full message content
 * GET    /v1/messages/:id/llm-context   — LLM request logs for a message
 * DELETE /v1/messages/queued/:id        — delete queued message
 */

import { z } from "zod";

import {
  deepMergeOverwrite,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { LLMConfigFragment } from "../../config/schemas/llm.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import { VALID_INFERENCE_PROVIDERS } from "../../config/schemas/services.js";
import {
  getEmbeddingConfigInfo,
  setEmbeddingConfig,
} from "../../daemon/handlers/config-embeddings.js";
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
import { getAssistantMessageIdsInTurn } from "../../memory/conversation-crud.js";
import {
  getRequestLogById,
  getRequestLogsByMessageId,
} from "../../memory/llm-request-log-store.js";
import { getMemoryRecallLogByMessageIds } from "../../memory/memory-recall-log-store.js";
import { resolvePricingForUsage } from "../../util/pricing.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";

const validProviderSet = new Set<string>(VALID_INFERENCE_PROVIDERS);
const validEmbeddingProviderSet = new Set<string>(
  VALID_MEMORY_EMBEDDING_PROVIDERS,
);

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

const INFERENCE_PROFILE_UI_KEYS = new Set([
  "provider",
  "model",
  "maxTokens",
  "effort",
  "speed",
  "verbosity",
  "temperature",
  "thinking",
]);

function asMutablePlainObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function replaceInferenceProfileConfig(
  raw: Record<string, unknown>,
  name: string,
  fragment: Record<string, unknown>,
): void {
  const existingLlm = asMutablePlainObject(raw.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) raw.llm = llm;

  const existingProfiles = asMutablePlainObject(llm.profiles);
  const profiles = existingProfiles ?? {};
  if (!existingProfiles) llm.profiles = profiles;

  const existingProfile = asMutablePlainObject(profiles[name]) ?? {};
  const nextProfile: Record<string, unknown> = { ...existingProfile };
  for (const key of INFERENCE_PROFILE_UI_KEYS) {
    delete nextProfile[key];
  }
  profiles[name] = { ...nextProfile, ...fragment };
}

function attachEstimatedCost(summary: LlmContextSummary): LlmContextSummary {
  const { provider, model, inputTokens, outputTokens } = summary;
  if (!model || inputTokens == null || outputTokens == null) {
    return summary;
  }

  const cacheCreation = summary.cacheCreationInputTokens ?? 0;
  const cacheRead = summary.cacheReadInputTokens ?? 0;
  const directInputTokens = Math.max(
    inputTokens - cacheCreation - cacheRead,
    0,
  );

  const result = resolvePricingForUsage(provider, model, {
    directInputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    anthropicCacheCreation: null,
  });

  return { ...summary, estimatedCostUsd: result.estimatedCostUsd };
}

function applyStoredProviderToLlmContextResult(
  normalized: LlmContextNormalizationResult,
  provider: string | null,
): LlmContextRouteResult {
  if (!provider) {
    const summary = normalized.summary
      ? attachEstimatedCost(normalized.summary)
      : undefined;
    return { ...normalized, summary } as LlmContextRouteResult;
  }

  const mergedSummary = normalized.summary
    ? { ...normalized.summary, provider }
    : { provider };
  const summary = attachEstimatedCost(mergedSummary as LlmContextSummary);
  return { ...normalized, summary };
}

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface ConversationQueryRouteDeps {
  /** Lazy factory for model set context (config reload suppression, conversation eviction). */
  getModelSetContext?: () => ModelSetContext;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationQueryRouteDefinitions(
  deps: ConversationQueryRouteDeps = {},
): HTTPRouteDefinition[] {
  return [
    // ── Model config ──────────────────────────────────────────────────
    {
      endpoint: "model",
      method: "GET",
      policyKey: "model",
      summary: "Get current model config",
      description:
        "Return the active LLM model ID, provider, and available models.",
      tags: ["config"],
      handler: async () => {
        const info = await getModelInfo();
        return Response.json(info);
      },
    },
    {
      endpoint: "model",
      method: "PUT",
      policyKey: "model",
      summary: "Set LLM model",
      description: "Change the active LLM model and optionally its provider.",
      tags: ["config"],
      requestBody: z.object({
        modelId: z.string(),
        provider: z.string().describe("Optional provider override").optional(),
      }),
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
      summary: "Set image generation model",
      description: "Change the active image generation model.",
      tags: ["config"],
      requestBody: z.object({
        modelId: z.string(),
      }),
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

    // ── Embedding config ─────────────────────────────────────────────
    {
      endpoint: "config/embeddings",
      method: "GET",
      policyKey: "config/embeddings",
      summary: "Get embedding config",
      description:
        "Return the active embedding provider, model, and available options.",
      tags: ["config"],
      handler: async () => {
        const info = await getEmbeddingConfigInfo();
        return Response.json(info);
      },
    },
    {
      endpoint: "config/embeddings",
      method: "PUT",
      policyKey: "config/embeddings",
      summary: "Set embedding config",
      description: "Change the embedding provider and optionally model.",
      tags: ["config"],
      requestBody: z.object({
        provider: z.string(),
        model: z.string().optional(),
      }),
      handler: async ({ req }) => {
        if (!deps.getModelSetContext) {
          return httpError(
            "INTERNAL_ERROR",
            "Embedding config not available",
            500,
          );
        }
        const body = (await req.json()) as {
          provider?: string;
          model?: string;
        };
        if (!body.provider || typeof body.provider !== "string") {
          return httpError(
            "BAD_REQUEST",
            "Missing required field: provider",
            400,
          );
        }
        if (!validEmbeddingProviderSet.has(body.provider)) {
          return httpError(
            "BAD_REQUEST",
            `Invalid provider "${body.provider}". Valid providers: ${[...validEmbeddingProviderSet].join(", ")}`,
            400,
          );
        }
        if (body.model !== undefined && typeof body.model !== "string") {
          return httpError(
            "BAD_REQUEST",
            "Field 'model' must be a string",
            400,
          );
        }
        try {
          const info = await setEmbeddingConfig(
            body.provider,
            body.model,
            deps.getModelSetContext(),
          );
          return Response.json(info);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return httpError(
            "INTERNAL_ERROR",
            `Failed to set embedding config: ${message}`,
            500,
          );
        }
      },
    },

    // ── Full config read ─────────────────────────────────────────────
    {
      endpoint: "config",
      method: "GET",
      policyKey: "config",
      summary: "Get full config",
      description: "Return the raw settings.json configuration object.",
      tags: ["config"],
      handler: () => {
        try {
          const raw = loadRawConfig();
          return Response.json(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return httpError(
            "INTERNAL_ERROR",
            `Failed to read config: ${message}`,
            500,
          );
        }
      },
    },

    // ── Generic config patch ──────────────────────────────────────────
    {
      endpoint: "config",
      method: "PATCH",
      policyKey: "config",
      summary: "Patch config",
      description:
        "Deep-merge a partial JSON object into the settings.json configuration.",
      tags: ["config"],
      handler: async ({ req }) => {
        const body = (await req.json()) as Record<string, unknown>;
        if (
          body == null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length === 0
        ) {
          return httpError(
            "BAD_REQUEST",
            "Body must be a non-empty JSON object",
            400,
          );
        }
        try {
          const raw = loadRawConfig();
          deepMergeOverwrite(raw, body);
          saveRawConfig(raw);
          return Response.json({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return httpError(
            "INTERNAL_ERROR",
            `Failed to patch config: ${message}`,
            500,
          );
        }
      },
    },

    // ── Inference profile replacement ─────────────────────────────────
    {
      endpoint: "config/llm/profiles/:name",
      method: "PUT",
      policyKey: "config",
      summary: "Replace an inference profile",
      description:
        "Replace the settings-UI-managed leaves of a single llm.profiles entry while preserving non-UI leaves.",
      tags: ["config"],
      handler: async ({ req, params }) => {
        const name = params.name.trim();
        if (!name) {
          return httpError(
            "BAD_REQUEST",
            "Profile name must be a non-empty string",
            400,
          );
        }

        const body = (await req.json()) as unknown;
        if (body == null || typeof body !== "object" || Array.isArray(body)) {
          return httpError("BAD_REQUEST", "Body must be a JSON object", 400);
        }

        const parsed = LLMConfigFragment.safeParse(body);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => issue.message)
            .join("; ");
          return httpError(
            "BAD_REQUEST",
            `Invalid profile fragment: ${detail}`,
            400,
          );
        }

        try {
          const raw = loadRawConfig();
          replaceInferenceProfileConfig(
            raw,
            name,
            parsed.data as Record<string, unknown>,
          );
          saveRawConfig(raw);
          return Response.json({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return httpError(
            "INTERNAL_ERROR",
            `Failed to replace inference profile: ${message}`,
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
      summary: "Search conversations",
      description:
        "Full-text search across conversation titles and message content.",
      tags: ["conversations"],
      responseBody: z.object({
        query: z.string(),
        results: z.array(z.unknown()),
      }),
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
      summary: "Get message content",
      description: "Return the full content of a single message by ID.",
      tags: ["messages"],
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
      summary: "Get LLM context for a message",
      description:
        "Return request/response logs and memory recall data for a specific message.",
      tags: ["messages"],
      responseBody: z.object({
        messageId: z.string(),
        logs: z.array(z.unknown()),
        memoryRecall: z.object({}).passthrough(),
      }),
      handler: ({ params }) => {
        const messageId = params.id;
        if (!messageId) {
          return httpError("BAD_REQUEST", "message id is required", 400);
        }
        const logs = getRequestLogsByMessageId(messageId);
        const turnMessageIds = getAssistantMessageIdsInTurn(messageId);
        const memoryRecallLog = getMemoryRecallLogByMessageIds(turnMessageIds);
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
              requestPayload: null,
              responsePayload: null,
              createdAt: log.createdAt,
              ...result,
            };
          }),
          memoryRecall: memoryRecallLog ?? null,
        });
      },
    },

    // ── Raw payload for a single LLM request log ─────────────────────
    {
      endpoint: "llm-request-logs/:id/payload",
      method: "GET",
      policyKey: "llm-request-logs/payload",
      summary: "Get raw payload for a single LLM request log",
      description:
        "Return the full request and response payloads for a specific log entry.",
      tags: ["messages"],
      responseBody: z.object({
        id: z.string(),
        requestPayload: z.unknown(),
        responsePayload: z.unknown(),
      }),
      handler: ({ params }) => {
        const logId = params.id;
        if (!logId) {
          return httpError("BAD_REQUEST", "log id is required", 400);
        }
        const log = getRequestLogById(logId);
        if (!log) {
          return httpError("NOT_FOUND", "log not found", 404);
        }
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
        return Response.json({
          id: log.id,
          requestPayload,
          responsePayload,
        });
      },
    },

    // ── Delete queued message ─────────────────────────────────────────
    {
      endpoint: "messages/queued/:id",
      method: "DELETE",
      policyKey: "messages/queued",
      summary: "Delete a queued message",
      description:
        "Remove a pending message from the conversation queue before it is processed.",
      tags: ["messages"],
      handler: ({ url, params }) => {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          return httpError(
            "BAD_REQUEST",
            "Missing required query parameter: conversationId",
            400,
          );
        }
        const result = deleteQueuedMessage(conversationId, params.id);
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
