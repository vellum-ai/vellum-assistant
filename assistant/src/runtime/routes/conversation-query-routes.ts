/**
 * Route definitions for model configuration, embedding configuration,
 * conversation search, message content, LLM
 * context inspection, and queued message deletion.
 *
 * GET    /v1/model                      — current model info
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
 * GET    /v1/llm-request-logs/:id/context — normalized context for a single log
 * DELETE /v1/messages/queued/:id        — delete queued message
 * POST   /v1/messages/queued/:id/steer — steer to a queued message
 */

import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { LlmContextResponseSchema } from "../../api/responses/llm-context-response.js";
import {
  type LatencyBreakdown,
  LatencyBreakdownSchema,
  LLMRequestLogEntrySchema,
} from "../../api/responses/llm-request-log-entry.js";
import {
  deepMergeOverwrite,
  fillContextDefaultsForMissingKeys,
  getConfig,
  getDeploymentContextDefaults,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
  withSuppressedConfigDiskWrites,
  withSuppressedConfigDiskWritesSync,
} from "../../config/loader.js";
import { AssistantConfigSchema } from "../../config/schema.js";
import { getSchemaAtPath } from "../../config/schema-utils.js";
import { LLMConfigFragment, ProfileEntry } from "../../config/schemas/llm.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import { ServiceModeSchema } from "../../config/schemas/services.js";
import { getConfigWatcher } from "../../daemon/config-watcher.js";
import {
  getEmbeddingConfigInfo,
  setEmbeddingConfig,
} from "../../daemon/handlers/config-embeddings.js";
import {
  getModelInfo,
  type ModelSetContext,
  setImageGenModel,
} from "../../daemon/handlers/config-model.js";
import {
  getMessageContent,
  performConversationSearch,
} from "../../daemon/handlers/conversation-history.js";
import {
  deleteQueuedMessage,
  steerToMessage,
} from "../../daemon/handlers/conversations.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  log,
} from "../../daemon/handlers/shared.js";
import {
  getAssistantMessageIdsInTurn,
  getConversation,
  getMessageById,
} from "../../persistence/conversation-crud.js";
import { getConversationByKey } from "../../persistence/conversation-key-store.js";
import { getDb } from "../../persistence/db-connection.js";
import { clearEmbeddingBackendCache } from "../../persistence/embeddings/embedding-backend.js";
import { getLlmRequestLogSource } from "../../persistence/llm-request-log-source.js";
import { type LogRow } from "../../persistence/llm-request-log-store.js";
import { getMemoryRecallLogByMessageIds } from "../../plugins/defaults/memory/memory-recall-log-store.js";
import { getMemoryV2ActivationLogByMessageIds } from "../../plugins/defaults/memory/memory-v2-activation-log-store.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../plugins/defaults/memory/v2/constants.js";
import { getMemoryV3SelectionForInspectorByMessageIds } from "../../plugins/defaults/memory/v3/selection-log-store.js";
import { PROVIDERS_REQUIRING_BASE_URL_AND_MODELS } from "../../providers/inference/auth.js";
import {
  createConnection,
  getConnection,
  LEGACY_MANAGED_CONNECTION_NAMES,
  listConnections,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "../../providers/inference/connections.js";
import { PROVIDER_CATALOG } from "../../providers/model-catalog.js";
import { initializeProviders } from "../../providers/registry.js";
import { MANAGED_ROUTABLE_PROVIDERS } from "../../providers/vellum-model-routing.js";
import { credentialKey } from "../../security/credential-key.js";
import { validateAllowlistFile } from "../../security/secret-allowlist.js";
import {
  resolvePricingForUsage,
  usesAnthropicPricingRules,
} from "../../util/pricing.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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

import {
  getEffectiveProfile,
  getEffectiveProfiles,
  INVARIANT_PROFILE_NAMES,
  MANAGED_PROFILE_NAMES,
} from "../../config/default-profile-catalog.js";
import { DEFAULT_PROFILE_KEYS } from "../../config/default-profile-names.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";

const RESERVED_PROFILE_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const INFERENCE_PROFILE_UI_KEYS = new Set([
  "provider",
  "provider_connection",
  "model",
  "maxTokens",
  "effort",
  "speed",
  "verbosity",
  "temperature",
  "topP",
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
  // `inputTokens` carries provider-shape-dependent cache accounting. Anthropic
  // Messages responses (native and OpenRouter `anthropic/*`) report `input_tokens`
  // already net of cache — cache-creation/read are separate, additive buckets —
  // so the full-rate portion IS `inputTokens`. OpenAI/Gemini report a total
  // prompt-token count with cached tokens as a subset, so the full-rate portion
  // is the total minus cache. `usesAnthropicPricingRules` selects the same
  // response shapes the pricing layer treats as Anthropic (keyed on the stored
  // transport provider + model), so it also distinguishes the cache accounting.
  const directInputTokens = usesAnthropicPricingRules(provider, model)
    ? Math.max(inputTokens, 0)
    : Math.max(inputTokens - cacheCreation - cacheRead, 0);

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

/**
 * `full` returns the complete normalized entry including request/response
 * sections; `summary` omits the sections so list responses stay small —
 * sections for a single call are fetched lazily through
 * `/v1/llm-request-logs/{logId}/context`.
 */
type LlmContextView = "full" | "summary";

function resolveLlmContextView(view: string | undefined): LlmContextView {
  if (view === undefined || view === "full") return "full";
  if (view === "summary") return "summary";
  throw new BadRequestError(
    `Invalid view parameter: ${view}. Expected "full" or "summary".`,
  );
}

/**
 * Parse the stored `latency_breakdown` JSON into a validated
 * {@link LatencyBreakdown}. Returns `null` for the common no-data case and
 * for malformed/legacy rows — a bad blob must never break the inspector.
 */
function parseLatencyBreakdown(raw: string | null): LatencyBreakdown | null {
  if (!raw) return null;
  try {
    const parsed = LatencyBreakdownSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeLlmContextLog(
  log: LogRow,
  view: LlmContextView = "full",
): LlmContextRouteResult & {
  id: string;
  requestPayload: null;
  responsePayload: null;
  createdAt: number;
  agentLoopExitReason: string | null;
  callSite: string | null;
  latency: LatencyBreakdown | null;
} {
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
    // Agent-loop exit reason for the iteration that produced this call,
    // stamped onto the most-recent unstamped log by
    // `conversation-agent-loop-handlers.ts` after the loop yields. Only the
    // terminal call in each loop iteration carries a value; non-terminal calls
    // land here as `null`.
    agentLoopExitReason: log.agentLoopExitReason ?? null,
    // Logical call site (`mainAgent`, `compactionAgent`,
    // `syntheticAgentErrorMessage`, …). Exposed to the inspector so synthetic
    // rows can be rendered distinctly without re-deriving the kind from
    // other fields — the frontend branches on this value alone, and the
    // existing `agent_loop_exit_reason` column tells it WHICH error fired.
    callSite: log.callSite ?? null,
    // Daemon-measured first-token latency waterfall, stamped on the row at
    // record time (like `callSite`) rather than derived from the payloads.
    latency: parseLatencyBreakdown(log.latencyBreakdown),
    ...result,
    ...(view === "summary"
      ? { requestSections: undefined, responseSections: undefined }
      : {}),
  };
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
      withSuppressedConfigDiskWritesSync(() => watcher.updateFingerprint());
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

function stripTransportHeadersRecursively(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripTransportHeadersRecursively(item);
    }
    return;
  }

  const object = readPlainObject(value);
  if (!object) return;
  const transport = readPlainObject(object.transport);
  if (transport) delete transport.headers;
  for (const child of Object.values(object)) {
    stripTransportHeadersRecursively(child);
  }
}

function containsTransportHeadersRecursively(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsTransportHeadersRecursively(item));
  }

  const object = readPlainObject(value);
  if (!object) return false;
  const transport = readPlainObject(object.transport);
  if (transport && Object.hasOwn(transport, "headers")) return true;
  return Object.values(object).some((child) =>
    containsTransportHeadersRecursively(child),
  );
}

function sanitizeMcpTransportHeadersForSettingsRead(config: unknown): void {
  const root = readPlainObject(config);
  if (!root) return;
  const mcp = readPlainObject(root.mcp);
  if (!mcp || !Object.hasOwn(mcp, "servers")) return;
  if (Array.isArray(mcp.servers)) {
    stripTransportHeadersRecursively(mcp.servers);
    return;
  }
  const servers = readPlainObject(mcp.servers);
  if (!servers) return;
  for (const server of Object.values(servers)) {
    stripTransportHeadersRecursively(server);
  }
}

function patchContainsMcpTransportHeaders(patch: unknown): boolean {
  const root = readPlainObject(patch);
  const mcp = readPlainObject(root?.mcp);
  if (!mcp || !Object.hasOwn(mcp, "servers")) return false;
  if (Array.isArray(mcp.servers)) {
    return containsTransportHeadersRecursively(mcp.servers);
  }
  const servers = readPlainObject(mcp.servers);
  if (!servers) return false;
  return Object.values(servers).some((server) =>
    containsTransportHeadersRecursively(server),
  );
}

function rejectMcpTransportHeaderWrite(patch: unknown): void {
  if (!patchContainsMcpTransportHeaders(patch)) return;
  throw new BadRequestError(
    "MCP authentication headers must be managed through MCP server add/update APIs, not generic config writes.",
  );
}

const WireProfileEntry = ProfileEntry.extend({
  supportsVision: z.boolean().optional(),
  invariant: z.boolean().optional(),
})
  .passthrough()
  .meta({ id: "ProfileEntry" });

/**
 * Wire shape of the `memory` section in config responses. Passthrough
 * preserves fields beyond `enabled` and `v2` so the client doesn't strip
 * unrecognised memory config that newer daemons may add.
 */
const MemoryWireConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    v2: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough()
  .meta({ id: "MemoryConfig" });

/**
 * Response schema for `GET /v1/config`.
 *
 * Describes the wire shape of the raw `settings.json` response after
 * context-default filling and vision-flag enrichment. All top-level fields
 * are optional because the on-disk config may be sparse. Additional
 * top-level config sections beyond what's typed here are preserved via
 * passthrough — this schema types the fields that web/macOS clients consume
 * without restricting the full config surface.
 */
const ConfigGetResponseSchema = z
  .object({
    llm: z
      .object({
        default: LLMConfigFragment.extend({
          provider_connection: z.string().optional(),
        }).optional(),
        profiles: z.record(z.string(), WireProfileEntry).optional(),
        profileOrder: z.array(z.string()).optional(),
        activeProfile: z.string().optional(),
        // The profile the advisor consults; excluded from chat-profile pickers.
        advisorProfile: z.string().optional(),
        callSites: z
          .record(
            z.string(),
            LLMConfigFragment.extend({
              profile: z.string().optional(),
            }).nullable(),
          )
          .optional(),
        profileSession: z
          .object({
            defaultTtlSeconds: z.number().optional(),
            maxTtlSeconds: z.number().optional(),
          })
          .optional(),
        pricingOverrides: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    memory: MemoryWireConfigSchema.optional(),
    services: z
      .object({
        "web-search": z
          .object({
            mode: ServiceModeSchema.optional(),
            provider: z.string().optional(),
          })
          .passthrough()
          .optional(),
        "web-fetch": z
          .object({
            mode: ServiceModeSchema.optional(),
            provider: z.string().optional(),
          })
          .passthrough()
          .optional(),
        "image-generation": z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .optional(),
        inference: z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .meta({ id: "ConfigGetResponse" });

/**
 * Given a `z.object(...)` schema, returns a new schema where every property
 * is `.nullable().optional()`. Used to express PATCH body semantics where any
 * field can be `null` (meaning "delete via deep-merge") or omitted (unchanged).
 */
function nullablePartial(schema: z.ZodObject<z.ZodRawShape>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    shape[key] = (value as z.ZodType).nullable().optional();
  }
  return z.object(shape);
}

/**
 * A single profile entry within a PATCH body. All fields are
 * `.nullable().optional()`: `null` = delete via deep-merge, omitted =
 * unchanged. Named so HeyAPI generates `ProfilePatchEntry` as a top-level
 * export in the SDK.
 */
const ProfilePatchEntrySchema = nullablePartial(ProfileEntry)
  .passthrough()
  .meta({ id: "ProfilePatchEntry" });

/**
 * A single call-site override within a PATCH body.
 */
const CallSiteOverrideDraftSchema = nullablePartial(
  LLMConfigFragment.extend({ profile: z.string().optional() }),
)
  .passthrough()
  .meta({ id: "CallSiteOverrideDraft" });

/**
 * Request body schema for `PATCH /v1/config`.
 *
 * Mirrors the response shape but every field is `.nullable().optional()`:
 * omitted keys are left unchanged by the daemon's deep-merge, `null` values
 * delete the key. Uses the same Zod enums as `ConfigGetResponseSchema` so
 * the generated SDK produces literal-union types — no hand-written patch
 * types needed downstream.
 */
const ConfigPatchRequestSchema = z
  .object({
    llm: z
      .object({
        default: nullablePartial(
          LLMConfigFragment.extend({
            provider_connection: z.string().optional(),
          }),
        )
          .passthrough()
          .nullable()
          .optional(),
        profiles: z
          .record(z.string(), ProfilePatchEntrySchema.nullable())
          .optional(),
        profileOrder: z.array(z.string()).optional(),
        activeProfile: z.string().nullable().optional(),
        advisorProfile: z.string().nullable().optional(),
        callSites: z
          .record(z.string(), CallSiteOverrideDraftSchema.nullable())
          .optional(),
        profileSession: z
          .object({
            defaultTtlSeconds: z.number().optional(),
            maxTtlSeconds: z.number().optional(),
          })
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    memory: MemoryWireConfigSchema.nullable().optional(),
    services: z
      .object({
        "web-search": z
          .object({
            mode: ServiceModeSchema.optional(),
            provider: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        "web-fetch": z
          .object({
            mode: ServiceModeSchema.optional(),
            provider: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        "image-generation": z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .nullable()
          .optional(),
        inference: z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .meta({ id: "ConfigPatchRequest" });

function handleGetConfig() {
  try {
    const config = applyContextDefaultsToRawConfig(loadRawConfig());
    sanitizeMcpTransportHeadersForSettingsRead(config);
    overlayEffectiveProfilesForWire(config);
    enrichProfilesForWire(config);
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to read config: ${message}`);
  }
}

/**
 * Replace `llm.profiles` in an outgoing config response with the effective
 * profile view (code-catalog default bodies + workspace overlays). Default
 * profile CONTENT is code-owned and the workspace holds at most a thin stub,
 * but clients (settings UI, sticky-profile pickers) need the full bodies to
 * render labels/models — so the wire view materializes them. Wire-only:
 * `normalizeManagedProfileWrites` reduces echoed bodies back to the
 * workspace-owned fields on the write paths, so a `config get` →
 * `config set` round-trip never persists catalog content.
 */
function overlayEffectiveProfilesForWire(config: unknown): void {
  const root = readPlainObject(config);
  if (!root) return;
  const existingLlm = readPlainObject(root.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) {
    root.llm = llm;
  }
  llm.profiles = getEffectiveProfiles(
    readPlainObject(llm.profiles) as Record<string, ProfileEntry> | undefined,
  );
}

/**
 * Per-profile keys that exist only on the wire — stamped onto config
 * responses by {@link enrichProfilesForWire}, never persisted to disk.
 * {@link stripWireOnlyProfileKeys} removes them from incoming writes so a
 * `config get` → `config set`/PATCH round-trip isn't rejected for phantom
 * fields; keep the stamp and strip lists in lock-step.
 */
const WIRE_ONLY_PROFILE_KEYS = new Set(["invariant", "supportsVision"]);

/**
 * Delete the wire-only keys ({@link WIRE_ONLY_PROFILE_KEYS}) from every
 * profile entry in a config-write fragment, in place.
 */
function stripWireOnlyProfileKeys(patch: unknown): void {
  const root = readPlainObject(patch);
  const llm = readPlainObject(root?.llm);
  const profiles = readPlainObject(llm?.profiles);
  if (!profiles) {
    return;
  }
  for (const profile of Object.values(profiles)) {
    const entry = readPlainObject(profile);
    if (!entry) {
      continue;
    }
    for (const key of WIRE_ONLY_PROFILE_KEYS) {
      delete entry[key];
    }
  }
}

/**
 * Normalize managed default-profile entries in a config-write fragment, in
 * place, so a `config get` → write round-trip of the enriched wire view is a
 * no-op while genuine edit attempts still reach the invariant guard's
 * precise rejections:
 *
 * - A default name backed by a user-source on-disk entry is a legacy shadow
 *   and stays fully editable — left untouched here.
 * - Echo-stripping: any field whose incoming value equals the current
 *   effective (wire) value is deleted from the fragment — it is catalog
 *   content the client read from us, not user input. Values that DIFFER stay
 *   in the fragment for {@link assertInvariantProfilesPreserved} to reject
 *   (or, for `status`, to judge as the one legal transition).
 * - A default name with NO on-disk entry is catalog-owned: after
 *   echo-stripping, any remaining content field, a `disabled` status, or a
 *   non-managed `source` is rejected — default names cannot be newly
 *   shadowed or given content. A clean echo reduces to a no-op
 *   `{source: "managed"}` stub.
 *
 * Entries are mutated (never replaced) so the normalization also reaches
 * `handleSetConfig`'s `raw` write, which shares object references with the
 * inspected patch shape.
 */
function normalizeManagedProfileWrites(patch: unknown): void {
  const root = readPlainObject(patch);
  const llm = readPlainObject(root?.llm);
  const profiles = readPlainObject(llm?.profiles);
  if (!profiles) {
    return;
  }

  const currentProfiles = readPlainObject(
    readPlainObject(loadRawConfig().llm)?.profiles,
  ) as Record<string, ProfileEntry> | undefined;

  for (const name of Object.keys(profiles)) {
    if (!MANAGED_PROFILE_NAMES.has(name)) continue;
    const entry = readPlainObject(profiles[name]);
    if (!entry) continue;

    const current = readPlainObject(currentProfiles?.[name]);
    if (current && current.source !== "managed") {
      // Legacy user-owned shadow: fully editable, normal custom-profile rules.
      continue;
    }

    const effective = readPlainObject(
      getEffectiveProfile(currentProfiles, name),
    );
    for (const key of Object.keys(entry)) {
      if (key === "source" || key === "status") continue;
      const matchesEffective =
        effective != null &&
        key in effective &&
        isDeepStrictEqual(entry[key], effective[key]);
      if (current == null || !(key in current)) {
        // Not on disk: a value matching the wire view is a client echo of
        // catalog content — drop it. Anything else stays for the guard.
        if (matchesEffective) {
          delete entry[key];
        }
        continue;
      }
      // The key exists on disk (a frozen overlay field, or stale content an
      // overlay persisted). Deleting it would read as a key removal on a
      // full-entry SET, so instead: an echo of the wire value that differs
      // from disk is pinned back to the on-disk value (no change for the
      // guard to reject); everything else is left for the guard's
      // frozen-field comparison.
      if (matchesEffective && !isDeepStrictEqual(entry[key], current[key])) {
        entry[key] = current[key];
      }
    }

    if (current) {
      // Existing stub: the guard compares the merged result against it and
      // rejects everything but the status re-enable.
      if (entry.source === undefined) {
        entry.source = "managed";
      }
      continue;
    }

    // No on-disk entry: the name is catalog-owned. Nothing but a clean echo
    // (which reduced to source/status above) may pass.
    if ("source" in entry && entry.source !== "managed") {
      throw new BadRequestError(
        `Cannot create profile "${name}" — the name is reserved for a code-defined default profile.`,
      );
    }
    if (
      "status" in entry &&
      entry.status != null &&
      entry.status !== "active"
    ) {
      throw new BadRequestError(`Cannot disable managed profile "${name}".`);
    }
    const residual = Object.keys(entry).filter(
      (key) => key !== "source" && key !== "status",
    );
    if (residual.length > 0) {
      throw new BadRequestError(
        `Cannot edit managed profile "${name}" fields [${residual.join(", ")}]. ` +
          `Managed profiles are read-only; duplicate to a custom profile to customize.`,
      );
    }
    entry.source = "managed";
  }
}

/**
 * Annotate each profile in `config.llm.profiles` with wire-only flags
 * (`WIRE_ONLY_PROFILE_KEYS`) — never persisted to disk:
 *
 * - `supportsVision`: resolved from the model catalog. Unknown (provider,
 *   model) pairs default to `true` (fail-open) so image upload remains
 *   available for custom / unlisted models.
 * - `invariant`: `true` for managed-source entries of the managed profile
 *   names (`INVARIANT_PROFILE_NAMES`); absent otherwise. Source-gated to
 *   match `assertInvariantProfilesPreserved` — a user-owned profile sharing
 *   a managed name is fully editable, so it must render as a normal custom
 *   profile.
 */
function enrichProfilesForWire(config: unknown): void {
  const root = readPlainObject(config);
  if (!root) return;
  const llm = readPlainObject(root.llm);
  if (!llm) return;
  const profiles = readPlainObject(llm.profiles);
  if (!profiles) return;

  for (const [name, profile] of Object.entries(profiles)) {
    const entry = readPlainObject(profile);
    if (!entry) continue;
    if (INVARIANT_PROFILE_NAMES.has(name) && entry.source === "managed") {
      entry.invariant = true;
    }
    const provider = entry.provider;
    const model = entry.model;
    if (typeof provider !== "string" || typeof model !== "string") continue;

    const catalogProvider = PROVIDER_CATALOG.find((p) => p.id === provider);
    const catalogModel = catalogProvider?.models.find((m) => m.id === model);
    entry.supportsVision = catalogModel?.supportsVision ?? true;
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
  const existingProfiles = asMutablePlainObject(getConfig().llm.profiles) ?? {};
  for (const name of Object.keys(profiles)) {
    if (profiles[name] !== null || !MANAGED_PROFILE_NAMES.has(name)) continue;
    // Only block deletion when the on-disk entry is Vellum-managed. A
    // user-owned profile sharing a managed name carries a non-managed `source`
    // and is freely deletable.
    const existing = asMutablePlainObject(existingProfiles[name]);
    if (existing?.source === "managed") {
      throw new BadRequestError(`Cannot delete managed profile "${name}".`);
    }
  }
}

/**
 * Enforce the managed-profile invariants at the config-write choke point.
 *
 * Protects the thin managed stubs (`INVARIANT_PROFILE_NAMES`) that live in
 * workspace config. Default profile CONTENT is code-owned and only exists on
 * the wire, so the guard's job is the stub itself: it checks entries present
 * in the OLD config, and `normalizeManagedProfileWrites` reduces incoming
 * managed entries to the workspace-owned fields before this comparison runs.
 *
 * Invariance is gated on managed ownership: a name is enforced only when the
 * OLD entry's `source` is `"managed"`. A user-owned profile sharing a
 * managed name stays fully editable and deletable — for os-beta that state
 * is real and supported, because the flag-gated reconcile refuses to
 * overwrite a same-named user profile.
 *
 * For each invariant name where the OLD raw config carries a managed-source
 * plain-object entry at `llm.profiles[name]`:
 *
 * - The NEW raw config must still carry a plain-object entry at the same
 *   path — deletion, non-object overwrite, and subtree replacement are all
 *   rejected by this single check, regardless of route.
 * - `status` is one-directional: effective status is
 *   `entry.status !== "disabled"` (absence/null = active). An active managed
 *   profile can never be disabled; a changed `status` must be `"active"`,
 *   `null`, or absent — re-enabling a disabled profile. Any other value is
 *   rejected.
 * - Wire-only keys (`WIRE_ONLY_PROFILE_KEYS`) are ignored on both sides:
 *   incoming writes have them stripped, but configs persisted before the
 *   strip existed may still carry them on disk, and treating that stale key
 *   as a removed field would reject every round-trip write until reboot
 *   reseeds the profile.
 * - Every other field is frozen: any changed, added, or removed key across
 *   the union of both entries' keys (except `status` and the wire-only keys)
 *   is rejected. A pre-existing on-disk override (e.g. `topP`) is preserved
 *   but frozen — it passes the guard only while it doesn't change.
 */
function assertInvariantProfilesPreserved(
  oldRaw: Record<string, unknown>,
  newRaw: Record<string, unknown>,
): void {
  const oldProfiles = asMutablePlainObject(
    asMutablePlainObject(oldRaw.llm)?.profiles,
  );
  if (!oldProfiles) {
    return;
  }
  const newProfiles = asMutablePlainObject(
    asMutablePlainObject(newRaw.llm)?.profiles,
  );

  for (const name of INVARIANT_PROFILE_NAMES) {
    const oldEntry = asMutablePlainObject(oldProfiles[name]);
    if (!oldEntry) {
      continue;
    }
    if (oldEntry.source !== "managed") {
      continue;
    }

    const newEntry = newProfiles
      ? asMutablePlainObject(newProfiles[name])
      : null;
    if (!newEntry) {
      throw new BadRequestError(
        `Cannot delete or replace managed profile "${name}". Managed profiles are read-only.`,
      );
    }

    if (!isDeepStrictEqual(oldEntry.status, newEntry.status)) {
      if (newEntry.status === "disabled") {
        throw new BadRequestError(`Cannot disable managed profile "${name}".`);
      }
      if (newEntry.status !== "active" && newEntry.status != null) {
        throw new BadRequestError(
          `Cannot set status ${JSON.stringify(newEntry.status)} on managed profile "${name}". ` +
            `Only re-enabling (status "active") is allowed.`,
        );
      }
    }

    const changedKeys = [
      ...new Set([...Object.keys(oldEntry), ...Object.keys(newEntry)]),
    ].filter(
      (key) =>
        key !== "status" &&
        !WIRE_ONLY_PROFILE_KEYS.has(key) &&
        !isDeepStrictEqual(oldEntry[key], newEntry[key]),
    );
    if (changedKeys.length > 0) {
      throw new BadRequestError(
        `Cannot edit managed profile "${name}" fields [${changedKeys.join(", ")}]. ` +
          `Managed profiles are read-only; duplicate to a custom profile to customize.`,
      );
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
  // `loadRawConfig()` reads fresh from disk and the save hasn't happened yet,
  // so it is the pre-write state; raw-to-raw comparison avoids parsed-vs-raw
  // false diffs. Runs before the watcher-suppress/save sequence so a
  // rejection needs no suppress-flag or cache cleanup.
  assertInvariantProfilesPreserved(loadRawConfig(), raw);

  // Suppress the file-watcher callback for the duration of the debounce
  // window. Without this, the ConfigWatcher detects the config.json write
  // ~200ms later, sees a stale fingerprint, and calls initializeProviders a
  // second time - starting with providers.clear() which races with the
  // explicit reinit below. The watcher also fires onConversationEvict(),
  // which would evict all cached conversations on every write. Mirror the
  // suppress/reset pattern used in setImageGenModel (config-model.ts).
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
  // Reinitialize providers so the live registry reflects the new config.
  // Suppress disk writes inside loadConfig() — we just wrote the raw config
  // and the first-launch seed path would overwrite it with full defaults.
  try {
    await withSuppressedConfigDiskWrites(async () => {
      await initializeProviders(getConfig());
      configWatcher.updateFingerprint();
    });
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
  stripWireOnlyProfileKeys(body);
  normalizeManagedProfileWrites(body);
  rejectManagedProfileDeletion(body as Record<string, unknown>);
  rejectMcpTransportHeaderWrite(body);

  const raw = loadRawConfig();
  const patch = body as Record<string, unknown>;
  deepMergeOverwrite(raw, patch);

  await commitConfigWrite(raw, "patch");

  const merged = applyContextDefaultsToRawConfig(loadRawConfig());
  sanitizeMcpTransportHeadersForSettingsRead(merged);
  overlayEffectiveProfilesForWire(merged);
  enrichProfilesForWire(merged);
  return merged;
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
  // A leaf-path SET targeting a wire-only profile key is dropped without
  // writing — the same treatment PATCH gives wire-only keys embedded in a
  // profile fragment.
  const pathSegments = path.split(".");
  if (
    pathSegments[0] === "llm" &&
    pathSegments[1] === "profiles" &&
    pathSegments.length >= 4 &&
    WIRE_ONLY_PROFILE_KEYS.has(pathSegments[3]!)
  ) {
    return { ok: true };
  }
  // Build the equivalent patch shape so the managed-profile guard can
  // inspect the touched subtree. `setNestedValue` places `value` into
  // `patchShape` by reference, so stripping wire-only profile keys here
  // also strips the object written to `raw` below.
  const patchShape: Record<string, unknown> = {};
  setNestedValue(patchShape, path, value);
  stripWireOnlyProfileKeys(patchShape);
  normalizeManagedProfileWrites(patchShape);
  rejectManagedProfileDeletion(patchShape);
  rejectMcpTransportHeaderWrite(patchShape);

  const raw = loadRawConfig();
  // A SET below the entry level (`llm.profiles.<name>.<leaf>`) writes the
  // primitive leaf directly into `raw`, bypassing the by-reference
  // normalization above — creating an entry for a managed-owned name would
  // leave it source-less, and a source-less entry reads as a user shadow
  // that blocks the catalog body. Stamp the managed marker onto the written
  // entry when the name was absent or managed-owned before this write.
  const managedEntryName =
    pathSegments[0] === "llm" &&
    pathSegments[1] === "profiles" &&
    pathSegments.length >= 3 &&
    MANAGED_PROFILE_NAMES.has(pathSegments[2]!)
      ? pathSegments[2]!
      : undefined;
  const priorManagedEntry = managedEntryName
    ? readPlainObject(
        readPlainObject(readPlainObject(raw.llm)?.profiles)?.[managedEntryName],
      )
    : undefined;
  setNestedValue(raw, path, value);
  if (
    managedEntryName &&
    (priorManagedEntry == null || priorManagedEntry.source === "managed")
  ) {
    const written = readPlainObject(
      readPlainObject(readPlainObject(raw.llm)?.profiles)?.[managedEntryName],
    );
    if (written && written.source === undefined) {
      written.source = "managed";
    }
  }

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

async function handleReplaceInferenceProfile({
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
  const parsed = ProfileEntry.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequestError(`Invalid profile fragment: ${detail}`);
  }
  // A managed name with no existing entry stays protected so users can't
  // shadow a seeded managed profile. An existing entry carrying a non-managed
  // `source` is user-owned and remains fully editable.
  const existingProfile = asMutablePlainObject(
    getConfig().llm.profiles?.[name],
  );
  const isManaged =
    MANAGED_PROFILE_NAMES.has(name) &&
    (existingProfile == null || existingProfile.source === "managed");
  // A flag-gated managed name (`os-beta`) with no materialized entry cannot
  // be patched: it only resolves while the flag reconcile has created its
  // stub, so writing status here would persist an entry that fights the
  // reconcile. The always-available defaults are catalog-owned even when
  // absent — a status re-enable on them just creates the thin stub.
  if (
    MANAGED_PROFILE_NAMES.has(name) &&
    existingProfile == null &&
    !(DEFAULT_PROFILE_KEYS as readonly string[]).includes(name)
  ) {
    throw new BadRequestError(
      `Profile "${name}" is not currently available and cannot be edited.`,
    );
  }
  if (isManaged) {
    // Managed profiles are daemon-seeded and read-only — the commit guard
    // (`assertInvariantProfilesPreserved`) rejects every write to them
    // except re-enabling a disabled profile. Enforce the same contract up
    // front: the only body a managed PUT accepts is a pure status re-enable
    // (`{status: "active"}`, or `{status: null}` to clear back to
    // active-by-absence). Rejecting here keeps the error message ahead of
    // any side effects and mirrors the guard's wording.
    const requestedKeys = Object.keys(parsed.data);
    const isStatusReenable =
      requestedKeys.length === 1 &&
      requestedKeys[0] === "status" &&
      (parsed.data.status === "active" || parsed.data.status === null);
    if (!isStatusReenable) {
      const disallowed = requestedKeys.filter((k) => k !== "status");
      const detail =
        disallowed.length > 0 ? ` fields [${disallowed.join(", ")}]` : "";
      throw new BadRequestError(
        `Cannot edit managed profile "${name}"${detail}. ` +
          `Managed profiles are read-only (a disabled profile can be re-enabled); ` +
          `duplicate to a custom profile to customize.`,
      );
    }
  }
  // Mix profiles reference other profiles by name. `ProfileEntry.safeParse`
  // above validates the fragment in isolation, so the cross-profile integrity
  // rules `LLMSchema.superRefine` enforces on full-config load (every arm
  // exists, no nesting, no self-reference, no config fields) must be checked
  // here against the live profile set — otherwise an invalid mix would persist
  // and break the next full config reparse.
  if (parsed.data.mix != null) {
    const MIX_ALLOWED_KEYS = new Set([
      "mix",
      "label",
      "description",
      "status",
      "source",
    ]);
    const extraneous = Object.keys(parsed.data).filter(
      (k) => !MIX_ALLOWED_KEYS.has(k),
    );
    if (extraneous.length > 0) {
      throw new BadRequestError(
        `Mix profile "${name}" cannot also set [${extraneous.join(", ")}] — a mix only references other profiles plus metadata (label, description, status).`,
      );
    }
    // Validate arms against the effective view (matches the resolver and
    // `LLMSchema.superRefine`), not the raw workspace record.
    const existingProfiles = getEffectiveProfiles(getConfig().llm.profiles);
    parsed.data.mix.forEach((arm, index) => {
      if (arm.profile === name) {
        throw new BadRequestError(
          `Mix profile "${name}" cannot reference itself (arm ${index}).`,
        );
      }
      const target = existingProfiles[arm.profile];
      if (target == null) {
        throw new BadRequestError(
          `Mix profile "${name}" references profile "${arm.profile}" which is not defined.`,
        );
      }
      if (target.mix != null) {
        throw new BadRequestError(
          `Mix profile "${name}" references another mix profile "${arm.profile}" — mixes cannot be nested; constituents must be standard profiles.`,
        );
      }
    });
  }

  // When the UI sends provider but no provider_connection, derive the connection
  // now so the config deep-merge doesn't inherit a stale connection from the
  // default layer. Managed entries are excluded: the managed gate above
  // already rejected any provider-carrying fragment, so their only surviving
  // body is a status re-enable, which derives no connection. A user-owned
  // profile sharing a managed name is fully editable, so it takes the
  // derivation like any other custom profile.
  const fragment = parsed.data as Record<string, unknown>;
  if (!isManaged && fragment.provider && !fragment.provider_connection) {
    const provider = fragment.provider as string;
    const db = getDb();
    // Exclude the orphaned legacy `*-managed` rows: they may still linger in
    // provider_connections on upgraded workspaces (hidden from the list route
    // until a follow-up migration deletes them). Auto-binding to one would keep
    // the profile stale and break it once those rows are removed.
    const [active] = listConnections(db, { provider }).filter(
      (c) => !LEGACY_MANAGED_CONNECTION_NAMES.has(c.name),
    );
    if (active) {
      fragment.provider_connection = active.name;
    } else if (
      MANAGED_ROUTABLE_PROVIDERS.has(provider) &&
      getConnection(db, VELLUM_MANAGED_CONNECTION_NAME)
    ) {
      // Managed-routable providers are served by the single Vellum-managed
      // connection; prefer it over lazily creating a personal connection.
      fragment.provider_connection = VELLUM_MANAGED_CONNECTION_NAME;
    } else if (!PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) {
      const connectionName = `${provider}-personal`;
      const isKeyless = provider === "ollama";
      const result = createConnection(db, {
        name: connectionName,
        provider,
        auth: isKeyless
          ? { type: "none" }
          : {
              type: "api_key",
              credential: credentialKey(provider, "api_key"),
            },
      });
      if (result.ok) {
        fragment.provider_connection = connectionName;
      }
    }
  }

  const raw = loadRawConfig();
  if (isManaged) {
    // Partial overlay: keep every existing key intact, only apply the status
    // re-enable (the sole body the managed gate above admits). Using
    // `replaceInferenceProfileConfig` here would wipe the seed-owned fields
    // (provider, model, advanced params) because that function assumes the
    // body carries the full UI surface.
    applyManagedProfileReenable(raw, name, fragment.status as "active" | null);
  } else {
    replaceInferenceProfileConfig(raw, name, fragment);
  }
  // Route through `commitConfigWrite` so profile edits flow through the
  // post-write side effects shared with `handlePatchConfig` /
  // `handleSetConfig`: file-watcher suppression so the in-process reload
  // doesn't race the explicit reinit, embedding backend cache clear,
  // in-process `getConfig` cache invalidation, and provider registry
  // reinitialization. `status: "disabled"` on a managed profile (and any
  // `provider` / `model` / `provider_connection` change on a custom
  // profile) must take effect immediately rather than waiting for the
  // next watcher tick.
  await commitConfigWrite(raw, "replace inference profile");
  return { ok: true };
}

/**
 * Apply the disabled→active re-enable to a managed profile entry, preserving
 * every other field already on disk (provider, model, advanced params, etc).
 * `status: "active"` sets the key; `null` clears it (active-by-absence).
 */
function applyManagedProfileReenable(
  raw: Record<string, unknown>,
  name: string,
  status: "active" | null,
): void {
  const existingLlm = asMutablePlainObject(raw.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) {
    raw.llm = llm;
  }

  const existingProfiles = asMutablePlainObject(llm.profiles);
  const profiles = existingProfiles ?? {};
  if (!existingProfiles) {
    llm.profiles = profiles;
  }

  const nextProfile: Record<string, unknown> = {
    ...(asMutablePlainObject(profiles[name]) ?? {}),
  };
  // Only reached for managed-owned names (the route's managed gate), so a
  // freshly created stub must carry the managed marker the effective view
  // and write guards key on.
  nextProfile.source = "managed";
  if (status === null) {
    delete nextProfile.status;
  } else {
    nextProfile.status = status;
  }
  profiles[name] = nextProfile;
}

async function handleSearchConversations({
  queryParams = {},
}: RouteHandlerArgs) {
  const q = queryParams.q;
  if (!q) {
    throw new BadRequestError("Missing required query parameter: q");
  }
  const limit = queryParams.limit ? Number(queryParams.limit) : undefined;
  const maxMessages = queryParams.maxMessagesPerConversation
    ? Number(queryParams.maxMessagesPerConversation)
    : undefined;
  const results = await performConversationSearch({
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

type ConversationKind =
  | "user"
  | "background"
  | "background_memory_consolidation"
  | "scheduled";

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

async function handleGetLlmContext({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  const messageId = pathParams.id;
  if (!messageId) {
    throw new BadRequestError("message id is required");
  }
  const view = resolveLlmContextView(queryParams.view);
  const source = await getLlmRequestLogSource();
  const logs = await source.getRequestLogsByMessageId(messageId);
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
  // v3 selections are keyed to the turn's message ids (stamped by the turn-end
  // backfill), independent of v2's tracker turn — so the panel shows whenever
  // the turn has v3 data, regardless of v2/v3 turn-counter drift.
  const memoryV3Selection =
    await getMemoryV3SelectionForInspectorByMessageIds(turnMessageIds);
  return {
    messageId,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: logs.map((log) => normalizeLlmContextLog(log, view)),
    memoryRecall: memoryRecallLog ?? null,
    memoryV2Activation: memoryV2Activation ?? null,
    memoryV3Selection,
  };
}

async function handleGetConversationLlmContext({
  queryParams = {},
}: RouteHandlerArgs) {
  const conversationKey = queryParams.conversationKey;
  const requestedConversationId = queryParams.conversationId;
  const view = resolveLlmContextView(queryParams.view);

  let conversationId: string | undefined = requestedConversationId;
  if (!conversationId && conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    conversationId = mapping?.conversationId;
  }

  if (!conversationId) {
    if (conversationKey) {
      return {
        conversationKey,
        conversationId: null,
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV2Activation: null,
        memoryV3Selection: null,
      };
    }
    throw new BadRequestError(
      "conversationKey or conversationId query parameter is required",
    );
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    if (conversationKey) {
      return {
        conversationKey,
        conversationId,
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV2Activation: null,
        memoryV3Selection: null,
      };
    }
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }

  const source = await getLlmRequestLogSource();
  const logs = await source.getRequestLogsByConversationId(conversation.id);
  const conversationKind = resolveConversationKind(
    conversation.source,
    conversation.conversationType,
  );
  const conversationTotalEstimatedCostUsd =
    conversation.totalEstimatedCost ?? null;

  return {
    conversationKey: conversationKey ?? null,
    conversationId: conversation.id,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: logs.map((log) => normalizeLlmContextLog(log, view)),
    memoryRecall: null,
    memoryV2Activation: null,
    memoryV3Selection: null,
  };
}

async function handleGetLlmRequestLogPayload({
  pathParams = {},
}: RouteHandlerArgs) {
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const source = await getLlmRequestLogSource();
  const log = await source.getRequestLogById(logId);
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

async function handleGetLlmRequestLogContext({
  pathParams = {},
}: RouteHandlerArgs) {
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const source = await getLlmRequestLogSource();
  const log = await source.getRequestLogById(logId);
  if (!log) {
    throw new NotFoundError("log not found");
  }
  return normalizeLlmContextLog(log);
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

function handleSteerToMessage({
  queryParams = {},
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const conversationId =
    queryParams.conversationId ??
    (body && typeof body === "object" && "conversationId" in body
      ? (body as Record<string, unknown>).conversationId
      : undefined);
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("Missing required parameter: conversationId");
  }
  const result = steerToMessage(conversationId, pathParams.id ?? "");
  if (result.steered) {
    return { ok: true, conversationId, requestId: pathParams.id };
  }
  if (result.reason === "conversation_not_found") {
    throw new NotFoundError("Conversation not found");
  }
  if (result.reason === "not_processing") {
    throw new BadRequestError(
      "Cannot steer: conversation is not currently processing",
    );
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get current model config",
    description:
      "Return the active LLM model ID, provider, and available models.",
    tags: ["config"],
    handler: handleGetModel,
  },
  {
    operationId: "model_image_gen_set",
    endpoint: "model/image-gen",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get full config",
    description: "Return the raw settings.json configuration object.",
    tags: ["config"],
    responseBody: ConfigGetResponseSchema,
    handler: handleGetConfig,
  },
  {
    operationId: "config_patch",
    endpoint: "config",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Patch config",
    description:
      "Deep-merge a partial JSON object into the settings.json configuration.",
    tags: ["config"],
    requestBody: ConfigPatchRequestSchema,
    responseBody: ConfigGetResponseSchema,
    handler: handlePatchConfig,
  },
  {
    operationId: "config_set",
    endpoint: "config/set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Replace an inference profile",
    description:
      "Replace the settings-UI-managed leaves of a single llm.profiles entry while preserving non-UI leaves.",
    tags: ["config"],
    requestBody: ProfileEntry,
    handler: handleReplaceInferenceProfile,
  },
  {
    operationId: "conversations_search",
    endpoint: "conversations/search",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    operationId: "conversations_llm_context_get",
    endpoint: "conversations/llm-context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get LLM context for a conversation",
    description:
      "Returns normalized LLM request/response logs for an entire conversation.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "conversationKey",
        required: false,
        schema: { type: "string" },
        description: "Stable external conversation key.",
      },
      {
        name: "conversationId",
        required: false,
        schema: { type: "string" },
        description: "Internal conversation identifier.",
      },
      {
        name: "view",
        required: false,
        schema: { type: "string", enum: ["full", "summary"] },
        description:
          "Response shape. 'summary' omits per-log request/response sections; defaults to 'full'.",
      },
    ],
    responseBody: LlmContextResponseSchema,
    handler: handleGetConversationLlmContext,
  },
  {
    operationId: "messages_llm_context_get",
    endpoint: "messages/:id/llm-context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get LLM context for a message",
    description:
      "Return request/response logs and memory recall data for a specific message.",
    tags: ["messages"],
    queryParams: [
      {
        name: "view",
        required: false,
        schema: { type: "string", enum: ["full", "summary"] },
        description:
          "Response shape. 'summary' omits per-log request/response sections; defaults to 'full'.",
      },
    ],
    responseBody: LlmContextResponseSchema,
    handler: handleGetLlmContext,
  },
  {
    operationId: "llm_request_logs_payload_get",
    endpoint: "llm-request-logs/:id/payload",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    operationId: "llm_request_logs_context_get",
    endpoint: "llm-request-logs/:id/context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get normalized context for a single LLM request log",
    description:
      "Return the normalized summary and request/response sections for a specific log entry.",
    tags: ["messages"],
    responseBody: LLMRequestLogEntrySchema,
    handler: handleGetLlmRequestLogContext,
  },
  {
    operationId: "messages_queued_delete",
    endpoint: "messages/queued/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
  {
    operationId: "messages_queued_steer",
    endpoint: "messages/queued/:id/steer",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Steer to a queued message",
    description:
      "Promote a queued message to the head of the queue and abort the current generation so it is processed next.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation ID (required)",
      },
    ],
    handler: handleSteerToMessage,
  },
];
