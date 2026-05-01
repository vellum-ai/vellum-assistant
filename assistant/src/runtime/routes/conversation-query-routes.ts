/**
 * Route definitions for model configuration, embedding configuration,
 * conversation search, message content, LLM
 * context inspection, and queued message deletion.
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
 * GET    /v1/llm-request-logs/:id/payload — raw payload for a single log
 * DELETE /v1/messages/queued/:id        — delete queued message
 */

import { z } from "zod";

import {
  deepMergeOverwrite,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { ProfileEntry } from "../../config/schemas/llm.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import { VALID_INFERENCE_PROVIDERS } from "../../config/schemas/services.js";
import {
  clearTwilioPublicBaseUrlManagedBy,
  configPatchSetsTwilioPublicBaseUrl,
} from "../../config/twilio-ingress-ownership.js";
import { getConfigWatcher } from "../../daemon/config-watcher.js";
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
import { getMemoryV2ActivationLogByMessageIds } from "../../memory/memory-v2-activation-log-store.js";
import { resolvePricingForUsage } from "../../util/pricing.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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

import { MANAGED_PROFILE_NAMES } from "../../config/seed-inference-profiles.js";

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

function mergeInferenceProfileContextWindow(
  existingProfile: Record<string, unknown>,
  fragment: Record<string, unknown>,
  nextProfile: Record<string, unknown>,
): void {
  const existingContextWindow =
    asMutablePlainObject(existingProfile.contextWindow) ?? {};
  const nextContextWindow: Record<string, unknown> = {
    ...existingContextWindow,
  };

  delete nextContextWindow.maxInputTokens;

  if (Object.hasOwn(fragment, "contextWindow")) {
    const fragmentContextWindow = asMutablePlainObject(fragment.contextWindow);
    if (
      fragmentContextWindow &&
      Object.hasOwn(fragmentContextWindow, "maxInputTokens")
    ) {
      nextContextWindow.maxInputTokens = fragmentContextWindow.maxInputTokens;
    }
  }

  if (Object.keys(nextContextWindow).length === 0) {
    delete nextProfile.contextWindow;
  } else {
    nextProfile.contextWindow = nextContextWindow;
  }
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
  const fragmentTopLevel = { ...fragment };
  delete fragmentTopLevel.contextWindow;
  profiles[name] = { ...nextProfile, ...fragmentTopLevel };
  mergeInferenceProfileContextWindow(
    existingProfile,
    fragment,
    profiles[name] as Record<string, unknown>,
  );
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
// Model set context — derived directly from the config watcher singleton
// ---------------------------------------------------------------------------

function getModelSetContext(): ModelSetContext {
  const watcher = getConfigWatcher();
  return {
    suppressConfigReload: watcher.suppressConfigReload,
    setSuppressConfigReload(value: boolean) {
      watcher.suppressConfigReload = value;
    },
    updateConfigFingerprint() {
      watcher.updateFingerprint();
    },
    debounceTimers: watcher.timers,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetModel() {
  return getModelInfo();
}

async function handleSetModel({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { modelId, provider } = body as {
    modelId?: string;
    provider?: string;
  };
  if (!modelId || typeof modelId !== "string") {
    throw new BadRequestError("Missing required field: modelId");
  }
  if (
    provider !== undefined &&
    (typeof provider !== "string" || !validProviderSet.has(provider))
  ) {
    throw new BadRequestError(
      `Invalid provider "${provider}". Valid providers: ${[...validProviderSet].join(", ")}`,
    );
  }
  try {
    return await setModel(modelId, getModelSetContext(), provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set model: ${message}`);
  }
}

async function handleSetImageGenModel({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { modelId } = body as { modelId?: string };
  if (!modelId || typeof modelId !== "string") {
    throw new BadRequestError("Missing required field: modelId");
  }
  try {
    setImageGenModel(modelId, getModelSetContext());
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set image gen model: ${message}`);
  }
}

async function handleGetEmbeddingConfig() {
  return getEmbeddingConfigInfo();
}

async function handleSetEmbeddingConfig({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { provider, model } = body as {
    provider?: string;
    model?: string;
  };
  if (!provider || typeof provider !== "string") {
    throw new BadRequestError("Missing required field: provider");
  }
  if (!validEmbeddingProviderSet.has(provider)) {
    throw new BadRequestError(
      `Invalid provider "${provider}". Valid providers: ${[...validEmbeddingProviderSet].join(", ")}`,
    );
  }
  if (model !== undefined && typeof model !== "string") {
    throw new BadRequestError("Field 'model' must be a string");
  }
  try {
    return await setEmbeddingConfig(provider, model, getModelSetContext());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set embedding config: ${message}`);
  }
}

function handleGetConfig() {
  try {
    return loadRawConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to read config: ${message}`);
  }
}

function rejectManagedProfileDeletion(body: Record<string, unknown>): void {
  const llm = asMutablePlainObject(body.llm);
  if (!llm) return;
  if ("profiles" in llm && llm.profiles === null) {
    throw new BadRequestError(
      "Cannot null llm.profiles — managed profiles would be deleted.",
    );
  }
  const profiles = asMutablePlainObject(llm.profiles);
  if (!profiles) return;
  for (const name of Object.keys(profiles)) {
    if (profiles[name] === null && MANAGED_PROFILE_NAMES.has(name)) {
      throw new BadRequestError(`Cannot delete managed profile "${name}".`);
    }
  }
}

function handlePatchConfig({ body }: RouteHandlerArgs) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length === 0
  ) {
    throw new BadRequestError("Body must be a non-empty JSON object");
  }
  rejectManagedProfileDeletion(body as Record<string, unknown>);
  try {
    const raw = loadRawConfig();
    const patch = body as Record<string, unknown>;
    const clearsTwilioPublicBaseUrlManager =
      configPatchSetsTwilioPublicBaseUrl(patch);
    deepMergeOverwrite(raw, patch);
    if (clearsTwilioPublicBaseUrlManager) {
      clearTwilioPublicBaseUrlManagedBy(raw);
    }
    saveRawConfig(raw);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to patch config: ${message}`);
  }
}

function handleReplaceInferenceProfile({
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const name = (pathParams.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Body must be a JSON object");
  }
  if (MANAGED_PROFILE_NAMES.has(name)) {
    throw new BadRequestError(
      `Cannot edit managed profile "${name}". Duplicate it to create a custom profile.`,
    );
  }
  const parsed = ProfileEntry.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequestError(`Invalid profile fragment: ${detail}`);
  }
  try {
    const raw = loadRawConfig();
    replaceInferenceProfileConfig(
      raw,
      name,
      parsed.data as Record<string, unknown>,
    );
    saveRawConfig(raw);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to replace inference profile: ${message}`);
  }
}

function handleSearchConversations({ queryParams = {} }: RouteHandlerArgs) {
  const q = queryParams.q;
  if (!q) {
    throw new BadRequestError("Missing required query parameter: q");
  }
  const limit = queryParams.limit ? Number(queryParams.limit) : undefined;
  const maxMessages = queryParams.maxMessagesPerConversation
    ? Number(queryParams.maxMessagesPerConversation)
    : undefined;
  const results = performConversationSearch({
    query: q,
    limit,
    maxMessagesPerConversation: maxMessages,
  });
  return { query: q, results };
}

function handleGetMessageContent({
  queryParams = {},
  pathParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId;
  const result = getMessageContent(
    pathParams.id ?? "",
    conversationId ?? undefined,
  );
  if (!result) {
    throw new NotFoundError(`Message ${pathParams.id} not found`);
  }
  return result;
}

function handleGetLlmContext({ pathParams = {} }: RouteHandlerArgs) {
  const messageId = pathParams.id;
  if (!messageId) {
    throw new BadRequestError("message id is required");
  }
  const logs = getRequestLogsByMessageId(messageId);
  const turnMessageIds = getAssistantMessageIdsInTurn(messageId);
  const memoryRecallLog = getMemoryRecallLogByMessageIds(turnMessageIds);
  const memoryV2Activation =
    getMemoryV2ActivationLogByMessageIds(turnMessageIds);
  return {
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
    memoryV2Activation: memoryV2Activation ?? null,
  };
}

function handleGetLlmRequestLogPayload({ pathParams = {} }: RouteHandlerArgs) {
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const log = getRequestLogById(logId);
  if (!log) {
    throw new NotFoundError("log not found");
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
  return { id: log.id, requestPayload, responsePayload };
}

function handleDeleteQueuedMessage({
  queryParams = {},
  pathParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId;
  if (!conversationId) {
    throw new BadRequestError(
      "Missing required query parameter: conversationId",
    );
  }
  const result = deleteQueuedMessage(conversationId, pathParams.id ?? "");
  if (result.removed) {
    return { ok: true, conversationId, requestId: pathParams.id };
  }
  if (result.reason === "conversation_not_found") {
    throw new NotFoundError("Conversation not found");
  }
  throw new NotFoundError("Queued message not found");
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "model_get",
    endpoint: "model",
    method: "GET",
    policyKey: "model",
    summary: "Get current model config",
    description:
      "Return the active LLM model ID, provider, and available models.",
    tags: ["config"],
    handler: handleGetModel,
  },
  {
    operationId: "model_set",
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
    handler: handleSetModel,
  },
  {
    operationId: "model_image_gen_set",
    endpoint: "model/image-gen",
    method: "PUT",
    policyKey: "model/image-gen",
    summary: "Set image generation model",
    description: "Change the active image generation model.",
    tags: ["config"],
    requestBody: z.object({ modelId: z.string() }),
    handler: handleSetImageGenModel,
  },
  {
    operationId: "config_embeddings_get",
    endpoint: "config/embeddings",
    method: "GET",
    policyKey: "config/embeddings",
    summary: "Get embedding config",
    description:
      "Return the active embedding provider, model, and available options.",
    tags: ["config"],
    handler: handleGetEmbeddingConfig,
  },
  {
    operationId: "config_embeddings_set",
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
    handler: handleSetEmbeddingConfig,
  },
  {
    operationId: "config_get",
    endpoint: "config",
    method: "GET",
    policyKey: "config",
    summary: "Get full config",
    description: "Return the raw settings.json configuration object.",
    tags: ["config"],
    handler: handleGetConfig,
  },
  {
    operationId: "config_patch",
    endpoint: "config",
    method: "PATCH",
    policyKey: "config",
    summary: "Patch config",
    description:
      "Deep-merge a partial JSON object into the settings.json configuration.",
    tags: ["config"],
    handler: handlePatchConfig,
  },
  {
    operationId: "config_llm_profiles_replace",
    endpoint: "config/llm/profiles/:name",
    method: "PUT",
    policyKey: "config",
    summary: "Replace an inference profile",
    description:
      "Replace the settings-UI-managed leaves of a single llm.profiles entry while preserving non-UI leaves.",
    tags: ["config"],
    handler: handleReplaceInferenceProfile,
  },
  {
    operationId: "conversations_search",
    endpoint: "conversations/search",
    method: "GET",
    policyKey: "conversations/search",
    summary: "Search conversations",
    description:
      "Full-text search across conversation titles and message content.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "q",
        required: true,
        schema: { type: "string" },
        description: "Search query",
      },
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max results",
      },
      {
        name: "maxMessagesPerConversation",
        schema: { type: "integer" },
        description: "Max messages per conversation",
      },
    ],
    responseBody: z.object({
      query: z.string(),
      results: z.array(z.unknown()),
    }),
    handler: handleSearchConversations,
  },
  {
    operationId: "messages_content_get",
    endpoint: "messages/:id/content",
    method: "GET",
    policyKey: "messages/content",
    summary: "Get message content",
    description: "Return the full content of a single message by ID.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Optional conversation ID filter",
      },
    ],
    handler: handleGetMessageContent,
  },
  {
    operationId: "messages_llm_context_get",
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
      memoryRecall: z.object({}).passthrough().nullable(),
      memoryV2Activation: z.object({}).passthrough().nullable(),
    }),
    handler: handleGetLlmContext,
  },
  {
    operationId: "llm_request_logs_payload_get",
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
    handler: handleGetLlmRequestLogPayload,
  },
  {
    operationId: "messages_queued_delete",
    endpoint: "messages/queued/:id",
    method: "DELETE",
    policyKey: "messages/queued",
    summary: "Delete a queued message",
    description:
      "Remove a pending message from the conversation queue before it is processed.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation ID (required)",
      },
    ],
    handler: handleDeleteQueuedMessage,
  },
];
