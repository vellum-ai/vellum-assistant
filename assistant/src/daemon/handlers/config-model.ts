import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import {
  setLlmDefaultField,
  setServiceField,
} from "../../config/raw-config-utils.js";
import { VALID_INFERENCE_PROVIDERS } from "../../config/schemas/services.js";
import type { ProviderCatalogEntry } from "../../providers/model-catalog.js";
import {
  isModelInCatalog,
  PROVIDER_CATALOG,
} from "../../providers/model-catalog.js";
import { getProviderDefaultModel } from "../../providers/model-intents.js";
import {
  getConfiguredProviders,
  isProviderAvailable,
} from "../../providers/provider-availability.js";
import { initializeProviders } from "../../providers/registry.js";
import type {
  ImageGenModelSetRequest,
  ModelSetRequest,
} from "../message-protocol.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  type HandlerContext,
  log,
} from "./shared.js";

/** Reverse lookup: model ID → provider, derived from PROVIDER_CATALOG. */
export const MODEL_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.flatMap((provider) =>
    provider.models.map(({ id }) => [id, provider.id]),
  ),
);

// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  model: string;
  provider: string;
  configuredProviders?: string[];
  availableModels?: Array<{ id: string; displayName: string }>;
  allProviders?: ProviderCatalogEntry[];
}

/** Return current model configuration. */
export async function getModelInfo(): Promise<ModelInfo> {
  const config = getConfig();
  const provider = config.llm.default.provider;

  return {
    model: config.llm.default.model,
    provider,
    configuredProviders: await getConfiguredProviders(),
    availableModels: PROVIDER_CATALOG.find((p) => p.id === provider)?.models,
    allProviders: PROVIDER_CATALOG,
  };
}

/**
 * Minimal interface for the side-effects needed by setModel / setImageGenModel.
 * Keeps the business logic decoupled from transport-specific HandlerContext.
 */
export interface ModelSetContext {
  conversations: Map<
    string,
    { isProcessing(): boolean; dispose(): void; markStale(): void }
  >;
  suppressConfigReload: boolean;
  setSuppressConfigReload(value: boolean): void;
  updateConfigFingerprint(): void;
  debounceTimers: { schedule(key: string, fn: () => void, ms: number): void };
}

/**
 * Set the active model. Returns the resulting ModelInfo, or throws on failure.
 * The caller is responsible for sending the response to the client.
 *
 * When `explicitProvider` is supplied, it takes precedence over automatic
 * provider inference from the model ID. If the provider changes and the
 * current model doesn't belong to the new provider's catalog, the model
 * is auto-reset to the provider's default.
 */
export async function setModel(
  modelId: string,
  ctx: ModelSetContext,
  explicitProvider?: string,
): Promise<ModelInfo> {
  const validProviders = new Set<string>(VALID_INFERENCE_PROVIDERS);

  // Validate explicit provider against allowlist
  if (explicitProvider && !validProviders.has(explicitProvider)) {
    throw new Error(
      `Invalid provider "${explicitProvider}". Valid providers: ${[...validProviders].join(", ")}`,
    );
  }

  // Resolve provider: explicit > MODEL_TO_PROVIDER lookup > current
  const current = getConfig();
  const resolvedProvider =
    explicitProvider ??
    MODEL_TO_PROVIDER[modelId] ??
    current.llm.default.provider;

  // Auto-reset model when provider changes and current modelId doesn't
  // belong to the new provider's catalog.
  if (
    resolvedProvider !== current.llm.default.provider &&
    !isModelInCatalog(resolvedProvider, modelId)
  ) {
    modelId = getProviderDefaultModel(resolvedProvider);
  }

  // No-op guard: skip expensive reinitialization when nothing changed
  if (
    modelId === current.llm.default.model &&
    resolvedProvider === current.llm.default.provider
  ) {
    return await getModelInfo();
  }

  // Validate provider availability (secure key, env var, or managed proxy) before switching
  if (!(await isProviderAvailable(resolvedProvider))) {
    // Return current model_info so the client resyncs its optimistic state
    return await getModelInfo();
  }

  // Use raw config to avoid persisting env-var API keys to disk
  const raw = loadRawConfig();
  setLlmDefaultField(raw, "model", modelId);
  setLlmDefaultField(raw, "provider", resolvedProvider);

  // Suppress the file watcher callback — setModel already does
  // the full reload sequence; a redundant watcher-triggered reload
  // would incorrectly evict sessions created after this method returns.
  const wasSuppressed = ctx.suppressConfigReload;
  ctx.setSuppressConfigReload(true);
  try {
    saveRawConfig(raw);
  } catch (err) {
    ctx.setSuppressConfigReload(wasSuppressed);
    throw err;
  }
  ctx.debounceTimers.schedule(
    "__suppress_reset__",
    () => {
      ctx.setSuppressConfigReload(false);
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  // Re-initialize provider with the new model so LLM calls use it
  const config = getConfig();
  await initializeProviders(config);

  // Evict idle conversations immediately; mark busy ones as stale so they
  // get recreated with the new provider once they finish processing.
  for (const [id, conversation] of ctx.conversations) {
    if (!conversation.isProcessing()) {
      conversation.dispose();
      ctx.conversations.delete(id);
    } else {
      conversation.markStale();
    }
  }

  ctx.updateConfigFingerprint();

  return await getModelInfo();
}

/**
 * Set the image generation model. Throws on failure.
 */
export function setImageGenModel(modelId: string, ctx: ModelSetContext): void {
  const raw = loadRawConfig();
  setServiceField(raw, "image-generation", "model", modelId);

  const wasSuppressed = ctx.suppressConfigReload;
  ctx.setSuppressConfigReload(true);
  try {
    saveRawConfig(raw);
  } catch (err) {
    ctx.setSuppressConfigReload(wasSuppressed);
    throw err;
  }
  ctx.debounceTimers.schedule(
    "__suppress_reset__",
    () => {
      ctx.setSuppressConfigReload(false);
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  ctx.updateConfigFingerprint();
  log.info({ model: modelId }, "Image generation model updated");
}

// ---------------------------------------------------------------------------
// HTTP handlers (delegate to shared logic)
// ---------------------------------------------------------------------------

export async function handleModelGet(ctx: HandlerContext): Promise<void> {
  const info = await getModelInfo();
  ctx.send({
    type: "model_info",
    ...info,
  });
}

export async function handleModelSet(
  msg: ModelSetRequest,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const info = await setModel(msg.model, ctx, msg.provider);
    ctx.send({ type: "model_info", ...info });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send({
      type: "error",
      message: `Failed to set model: ${message}`,
    });
  }
}

export function handleImageGenModelSet(
  msg: ImageGenModelSetRequest,
  ctx: HandlerContext,
): void {
  try {
    setImageGenModel(msg.model, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `Failed to set image gen model: ${message}`);
  }
}
