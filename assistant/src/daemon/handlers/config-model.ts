import {
  API_KEY_PROVIDERS,
  getConfig,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { initializeProviders } from "../../providers/registry.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { MODEL_TO_PROVIDER } from "../conversation-slash.js";
import type {
  ImageGenModelSetRequest,
  ModelSetRequest,
} from "../message-protocol.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  type HandlerContext,
  log,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  model: string;
  provider: string;
  configuredProviders?: string[];
}

/** Return current model configuration. */
export async function getModelInfo(): Promise<ModelInfo> {
  const config = getConfig();
  const configured: string[] = [];
  for (const p of API_KEY_PROVIDERS) {
    if (await getProviderKeyAsync(p)) {
      configured.push(p);
    }
  }
  if (!configured.includes("ollama")) configured.push("ollama");
  return {
    model: config.model,
    provider: config.provider,
    configuredProviders: configured,
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
 */
export async function setModel(
  modelId: string,
  ctx: ModelSetContext,
): Promise<ModelInfo> {
  // If the requested model is already the current model AND the provider
  // is already aligned with what MODEL_TO_PROVIDER expects, skip expensive
  // reinitialization but still return model_info so the client confirms.
  {
    const current = getConfig();
    const expectedProvider = MODEL_TO_PROVIDER[modelId];
    const providerAligned =
      !expectedProvider || current.provider === expectedProvider;
    if (modelId === current.model && providerAligned) {
      return await getModelInfo();
    }
  }

  // Validate API key before switching
  const provider = MODEL_TO_PROVIDER[modelId];
  if (provider && provider !== "ollama") {
    if (!(await getProviderKeyAsync(provider))) {
      // Return current model_info so the client resyncs its optimistic state
      return await getModelInfo();
    }
  }

  // Use raw config to avoid persisting env-var API keys to disk
  const raw = loadRawConfig();
  raw.model = modelId;
  // Infer provider from model ID to keep provider and model in sync
  raw.provider = provider ?? raw.provider;

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

  // Evict idle sessions immediately; mark busy ones as stale so they
  // get recreated with the new provider once they finish processing.
  for (const [id, session] of ctx.conversations) {
    if (!session.isProcessing()) {
      session.dispose();
      ctx.conversations.delete(id);
    } else {
      session.markStale();
    }
  }

  ctx.updateConfigFingerprint();

  return { model: config.model, provider: config.provider };
}

/**
 * Set the image generation model. Throws on failure.
 */
export function setImageGenModel(modelId: string, ctx: ModelSetContext): void {
  const raw = loadRawConfig();
  raw.imageGenModel = modelId;

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
    const info = await setModel(msg.model, ctx);
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
