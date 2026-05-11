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
  fillContextDefaultsForMissingKeys,
  getConfig,
  getDeploymentContextDefaults,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { AssistantConfigSchema } from "../../config/schema.js";
import { getSchemaAtPath } from "../../config/schema-utils.js";
import { ProfileEntry } from "../../config/schemas/llm.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import { VALID_INFERENCE_PROVIDERS } from "../../config/schemas/services.js";
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
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  log,
} from "../../daemon/handlers/shared.js";
import {
  getAssistantMessageIdsInTurn,
  getConversation,
  getMessageById,
} from "../../memory/conversation-crud.js";
import { clearEmbeddingBackendCache } from "../../memory/embedding-backend.js";
import {
  getRequestLogById,
  getRequestLogsByMessageId,
} from "../../memory/llm-request-log-store.js";
import { getMemoryRecallLogByMessageIds } from "../../memory/memory-recall-log-store.js";
import { getMemoryV2ActivationLogByMessageIds } from "../../memory/memory-v2-activation-log-store.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../memory/v2/constants.js";
import { initializeProviders } from "../../providers/registry.js";
import { validateAllowlistFile } from "../../security/secret-allowlist.js";
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

const RESERVED_PROFILE_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

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

/**
 * Apply deployment-context defaults to a raw config payload before it goes
 * out over the wire from `GET /v1/config`. The in-memory `loadConfig()`
 * already layers these defaults for daemon-internal consumers; the GET
 * response needs the same treatment so external clients (macOS, web, CLI)
 * see the effective value rather than `undefined` when the daemon hasn't
 * persisted an explicit choice yet. For example, on a freshly-hatched
 * platform-managed assistant, `services.image-generation.mode` may be absent
 * from disk (only `llm.profiles` was written by `seedInferenceProfiles`); the
 * fill pass ensures clients receive `"managed"` rather than falling back to
 * their own defaults.
 *
 * Guards against `loadRawConfig()` handing us a value that is technically
 * valid JSON but not a plain object (e.g. literal `null`, a number, or an
 * array). `loadRawConfig` is typed `Record<string, unknown>` but `JSON.parse`
 * itself doesn't enforce that — a malformed-but-parseable `config.json`
 * would blow up `fillContextDefaultsForMissingKeys` on its `target[key]` /
 * `fileConfig[key]` accesses, turning `GET /v1/config` into a 500 where it
 * used to succeed (returning the malformed payload as-is). When `raw` is
 * not a plain object, we return it unchanged.
 *
 * Exported for direct unit testing.
 */
export function applyContextDefaultsToRawConfig(raw: unknown): unknown {
  const contextDefaults = getDeploymentContextDefaults();
  if (
    Object.keys(contextDefaults).length === 0 ||
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return raw;
  }
  fillContextDefaultsForMissingKeys(
    raw as Record<string, unknown>,
    raw as Record<string, unknown>,
    contextDefaults,
  );
  synthesizeLegacyInferenceModeForPlatform(raw as Record<string, unknown>);
  return raw;
}

/**
 * Backwards-compat wire field for `GET /v1/config`. PR removed
 * `services.inference.mode` from the typed schema (routing is now governed
 * by `provider_connections` rows + `llm.default.provider_connection`), but
 * the macOS settings client (`SettingsStore.swift:loadServiceModes`) still
 * reads this field and falls back to its `@Published` default of "your-own"
 * when absent. On a platform-managed assistant served by a newer daemon and
 * an older macOS client, that fallback would show the wrong mode in the UI
 * until the user explicitly saved. Synthesize the value here so the wire
 * shape stays compatible during the rollout window. Remove once the macOS
 * Providers UI (the follow-up PR that retires this field on the client) has
 * shipped to the majority of installs.
 *
 * The synthesis is wire-only: it never persists to disk and never reaches
 * the typed `AssistantConfig` consumed by daemon-internal code. The on-disk
 * config is stripped of `mode` by workspace migration 076.
 *
 * Only runs when this function is reached, which is guarded by
 * `getDeploymentContextDefaults()` returning non-empty (IS_PLATFORM=true).
 */
function synthesizeLegacyInferenceModeForPlatform(
  root: Record<string, unknown>,
): void {
  const services = readPlainObject(root.services);
  if (!services) return;
  let inference = readPlainObject(services.inference);
  if (!inference) {
    inference = {};
    services.inference = inference;
  }
  if (inference.mode === undefined) {
    inference.mode = "managed";
  }
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function handleGetConfig() {
  try {
    return applyContextDefaultsToRawConfig(loadRawConfig());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to read config: ${message}`);
  }
}

/**
 * Return the JSON Schema for the assistant config (full or scoped).
 *
 * The schema is derived from `AssistantConfigSchema` at runtime via
 * `z.toJSONSchema()`. Pure read; no daemon state involved.
 */
function handleGetConfigSchema({ queryParams = {} }: RouteHandlerArgs) {
  const rawPath = queryParams.path;
  const path = typeof rawPath === "string" ? rawPath.trim() : "";

  if (!path) {
    return {
      schema: z.toJSONSchema(AssistantConfigSchema, {
        unrepresentable: "any",
        io: "input",
      }),
    };
  }

  const subSchema = getSchemaAtPath(AssistantConfigSchema, path);
  if (!subSchema) {
    throw new BadRequestError(`No schema found at path: ${path}`);
  }

  return {
    schema: z.toJSONSchema(subSchema, {
      unrepresentable: "any",
      io: "input",
    }),
  };
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

/**
 * Persist a mutated raw config object to disk and synchronize the running
 * daemon (file-watcher, embedding cache, provider registry).
 *
 * Shared by `handlePatchConfig` and `handleSetConfig` so both write paths get
 * identical post-write side effects.
 */
async function commitConfigWrite(
  raw: Record<string, unknown>,
  opLabel: string,
): Promise<void> {
  // Suppress the file-watcher callback for the duration of the debounce
  // window. Without this, the ConfigWatcher detects the config.json write
  // ~200ms later, sees a stale fingerprint, and calls initializeProviders a
  // second time - starting with providers.clear() which races with the
  // explicit reinit below. The watcher also fires onConversationEvict(),
  // which would evict all cached conversations on every write. Mirror the
  // suppress/reset pattern used in setModel (config-model.ts).
  const configWatcher = getConfigWatcher();
  const wasSuppressed = configWatcher.suppressConfigReload;
  configWatcher.suppressConfigReload = true;
  try {
    saveRawConfig(raw);
  } catch (err) {
    configWatcher.suppressConfigReload = wasSuppressed;
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to ${opLabel} config: ${message}`);
  }
  configWatcher.timers.schedule(
    "__suppress_reset__",
    () => {
      configWatcher.suppressConfigReload = false;
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  clearEmbeddingBackendCache();
  invalidateConfigCache();
  // Reinitialize providers so the live registry reflects the new config
  // (e.g. a mode flip between managed and your-own). Isolated try/catch so
  // a provider reinit failure doesn't mask the successful config save.
  // Only advance the config fingerprint on success - if reinit failed, leave
  // it stale so the watcher can detect the saved config on the next event
  // and retry provider initialization.
  try {
    await initializeProviders(getConfig());
    configWatcher.updateFingerprint();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `${opLabel} config: provider reinit failed: ${message}`);
  }
}

async function handlePatchConfig({ body }: RouteHandlerArgs) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length === 0
  ) {
    throw new BadRequestError("Body must be a non-empty JSON object");
  }
  rejectManagedProfileDeletion(body as Record<string, unknown>);

  const raw = loadRawConfig();
  const patch = body as Record<string, unknown>;
  deepMergeOverwrite(raw, patch);

  await commitConfigWrite(raw, "patch");
  return { ok: true };
}

/**
 * Direct path assignment - replaces `config_patch` for the `assistant
 * config set <key> <value>` CLI path.
 *
 * `config_patch` uses `deepMergeOverwrite` semantics, which strips `null`
 * leaves when the target subtree doesn't exist and merges (rather than
 * replaces) object subtrees. That's correct for partial updates (embedding
 * config, profile patches) but breaks single-key `set` semantics, where the
 * user expects:
 *   - `set heartbeat.activeHoursStart null` to persist explicit `null`
 *   - `set llm {}` to replace `llm`, not merge into it
 *
 * `config_set` performs `setNestedValue` directly on the loaded raw config
 * (no merge), then runs the same post-write side effects as patch.
 */
async function handleSetConfig({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError(
      "Body must be a JSON object with `path` and `value`",
    );
  }
  const bodyRecord = body as Record<string, unknown>;
  const { path, value } = bodyRecord as { path?: unknown; value?: unknown };
  if (typeof path !== "string" || path.length === 0) {
    throw new BadRequestError("`path` must be a non-empty string");
  }
  // `value` must be present (use explicit `null` to clear a key). Without
  // this check, `undefined` flows into `setNestedValue` and gets dropped by
  // `JSON.stringify` at save time, silently removing the key - which is
  // distinct from the documented "set to null" semantics.
  if (!("value" in bodyRecord)) {
    throw new BadRequestError(
      "`value` is required (use `null` to clear a key)",
    );
  }
  // Build the equivalent patch shape so the managed-profile guard can
  // inspect the touched subtree.
  const patchShape: Record<string, unknown> = {};
  setNestedValue(patchShape, path, value);
  rejectManagedProfileDeletion(patchShape);

  const raw = loadRawConfig();
  setNestedValue(raw, path, value);

  await commitConfigWrite(raw, "set");
  return { ok: true };
}

/**
 * Validate the regex patterns inside the workspace's
 * `secret-allowlist.json` file.
 *
 * Pure read: opens the file, attempts to compile each pattern, returns
 * structured errors. The handler returns `{ exists: false }` if the file is
 * absent, or `{ exists: true, errors: [...] }` otherwise.
 */
function handleValidateAllowlist() {
  try {
    const errors = validateAllowlistFile();
    if (errors == null) return { exists: false } as const;
    return { exists: true, errors } as const;
  } catch (err) {
    // `validateAllowlistFile` does a raw `JSON.parse` on
    // `secret-allowlist.json` and can throw on malformed JSON. Surface
    // that as a structured `parseError` in the response payload instead
    // of letting it propagate as a 500. Preserves the pre-IPC CLI
    // behavior, which printed a user-readable failure and exited 1.
    const message = err instanceof Error ? err.message : String(err);
    return { exists: true, parseError: message, errors: [] } as const;
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
  if (RESERVED_PROFILE_NAMES.has(name)) {
    throw new BadRequestError(
      `Profile name "${name}" is reserved and cannot be used.`,
    );
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

const CONVERSATION_KINDS = [
  "user",
  "background",
  "background_memory_consolidation",
  "scheduled",
] as const;
type ConversationKind = (typeof CONVERSATION_KINDS)[number];

function resolveConversationKind(
  source: string,
  conversationType: string,
): ConversationKind {
  if (source === MEMORY_V2_CONSOLIDATION_SOURCE) {
    return "background_memory_consolidation";
  }
  if (conversationType === "background") return "background";
  if (conversationType === "scheduled") return "scheduled";
  return "user";
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
  const message = getMessageById(messageId);
  const conversation = message ? getConversation(message.conversationId) : null;
  const conversationKind: ConversationKind = conversation
    ? resolveConversationKind(
        conversation.source,
        conversation.conversationType,
      )
    : "user";
  // Running total of estimated USD cost across every priced LLM call in
  // the conversation. Maintained by `updateConversationUsage` whenever a
  // turn finishes — see `assistant/src/memory/conversation-crud.ts`.
  const conversationTotalEstimatedCostUsd =
    conversation?.totalEstimatedCost ?? null;
  return {
    messageId,
    conversationKind,
    conversationTotalEstimatedCostUsd,
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
    operationId: "config_set",
    endpoint: "config/set",
    method: "POST",
    policyKey: "config/set",
    summary: "Set a single config path",
    description:
      "Assign a value at a dotted config path with direct-replacement semantics " +
      "(preserves explicit null, replaces object subtrees instead of merging). " +
      "Used by the `assistant config set <key> <value>` CLI command.",
    tags: ["config"],
    handler: handleSetConfig,
  },
  {
    operationId: "config_allowlist_validate",
    endpoint: "config/allowlist/validate",
    method: "GET",
    policyKey: "config/allowlist/validate",
    summary: "Validate secret-allowlist.json regex patterns",
    description:
      "Compile each regex pattern in secret-allowlist.json and return any " +
      "syntax errors. Returns { exists: false } if no file is present.",
    tags: ["config"],
    handler: handleValidateAllowlist,
  },
  {
    operationId: "config_schema_get",
    endpoint: "config/schema",
    method: "GET",
    policyKey: "config/schema",
    summary: "Get config JSON Schema",
    description:
      "Return the JSON Schema for the assistant config, optionally scoped to a dotted-path sub-schema (e.g. ?path=calls).",
    tags: ["config"],
    queryParams: [
      {
        name: "path",
        schema: { type: "string" },
        description: "Optional dotted path to a config sub-key",
      },
    ],
    handler: handleGetConfigSchema,
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
      conversationKind: z.enum(CONVERSATION_KINDS),
      conversationTotalEstimatedCostUsd: z.number().nullable(),
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
