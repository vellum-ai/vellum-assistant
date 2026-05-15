import { resolveCallSiteConfig } from "../../config/llm-resolver.js";
import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { setServiceField } from "../../config/raw-config-utils.js";
import { providerForImageModelPrefix } from "../../media/types.js";
import type { ProviderCatalogEntry } from "../../providers/model-catalog.js";
import { getConfiguredProviders } from "../../providers/provider-availability.js";
import { getVisibleProviderCatalog } from "../../providers/provider-catalog-visibility.js";
import { CONFIG_RELOAD_DEBOUNCE_MS, log } from "./shared.js";

// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

/**
 * Wire-contract shape for a provider entry in `ModelInfo.allProviders`.
 * Mirrors the legacy fields declared in `message-types/conversations.ts` —
 * rich provider metadata (capability flags, pricing, subtitle, setupMode,
 * setupHint, envVar, credentialsGuide) is sourced by clients from the
 * bundled `LLMProviderRegistry` JSON, so there is no reason to double-send
 * it over the wire.
 */
export interface WireProviderEntry {
  id: string;
  displayName: string;
  models: Array<{ id: string; displayName: string }>;
  defaultModel: string;
  apiKeyUrl?: string;
  apiKeyPlaceholder?: string;
}

export interface ModelInfo {
  model: string;
  provider: string;
  configuredProviders?: string[];
  availableModels?: Array<{ id: string; displayName: string }>;
  allProviders?: WireProviderEntry[];
}

/**
 * Project a rich `ProviderCatalogEntry` to the legacy wire-contract fields.
 * Keeping the wire payload honest avoids contract drift with
 * `message-types/conversations.ts` and the generated Swift DTO.
 */
export function projectProviderForWire(
  entry: ProviderCatalogEntry,
): WireProviderEntry {
  return {
    id: entry.id,
    displayName: entry.displayName,
    models: entry.models.map((m) => ({ id: m.id, displayName: m.displayName })),
    defaultModel: entry.defaultModel,
    ...(entry.apiKeyUrl !== undefined && { apiKeyUrl: entry.apiKeyUrl }),
    ...(entry.apiKeyPlaceholder !== undefined && {
      apiKeyPlaceholder: entry.apiKeyPlaceholder,
    }),
  };
}

/** Return current model configuration. */
export async function getModelInfo(): Promise<ModelInfo> {
  const config = getConfig();
  const resolved = resolveCallSiteConfig("mainAgent", config.llm);
  const provider = resolved.provider;
  const visibleCatalog = getVisibleProviderCatalog(config);

  return {
    model: resolved.model,
    provider,
    configuredProviders: await getConfiguredProviders(),
    availableModels: visibleCatalog
      .find((p) => p.id === provider)
      ?.models?.map((m) => ({ id: m.id, displayName: m.displayName })),
    allProviders: visibleCatalog.map(projectProviderForWire),
  };
}

/**
 * Minimal interface for the side-effects needed by setImageGenModel.
 * Keeps the business logic decoupled from transport-specific server context.
 */
export interface ModelSetContext {
  suppressConfigReload: boolean;
  setSuppressConfigReload(value: boolean): void;
  updateConfigFingerprint(): void;
  debounceTimers: { schedule(key: string, fn: () => void, ms: number): void };
}

/**
 * Set the image generation model. Throws on failure.
 */
export function setImageGenModel(modelId: string, ctx: ModelSetContext): void {
  const raw = loadRawConfig();
  setServiceField(raw, "image-generation", "model", modelId);
  // Keep the derived provider in sync with the selected model so downstream
  // routing never sends a Gemini request to an OpenAI model (or vice versa).
  // The prefix logic is shared with workspace migration 006-services-config
  // via providerForImageModelPrefix().
  setServiceField(
    raw,
    "image-generation",
    "provider",
    providerForImageModelPrefix(modelId),
  );

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
