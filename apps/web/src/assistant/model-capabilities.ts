/**
 * Mirrors macOS `InferenceProfileParameterVisibility.resolve()` from
 * `clients/macos/vellum-assistant/Features/Settings/InferenceProfileParameterVisibility.swift`.
 *
 * Determines which advanced parameter controls to show in ProfileEditorModal
 * based on the selected provider and model. All fields default false when
 * provider or model is absent.
 */

import { getModelsForProvider } from "@/assistant/llm-model-catalog";

export interface ProfileParamVisibility {
  maxTokens: boolean;
  contextWindow: boolean;
  effort: boolean;
  speed: boolean;
  verbosity: boolean;
  temperature: boolean;
  thinking: boolean;
}

export const VISIBILITY_NONE: ProfileParamVisibility = {
  maxTokens: false,
  contextWindow: false,
  effort: false,
  speed: false,
  verbosity: false,
  temperature: false,
  thinking: false,
};

function isOpenAIGPT5Family(modelId: string): boolean {
  return modelId === "gpt-5" || modelId.startsWith("gpt-5.") || modelId.startsWith("gpt-5-");
}

function isOpenRouterAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}

function knownOpenRouterReasoningModel(modelId: string): boolean {
  return (
    isOpenRouterAnthropicModel(modelId) ||
    modelId.startsWith("x-ai/grok-4") ||
    modelId.startsWith("deepseek/deepseek-r1") ||
    modelId === "qwen/qwen3.5-plus-02-15" ||
    modelId === "qwen/qwen3.5-397b-a17b" ||
    modelId === "moonshotai/kimi-k2.6"
  );
}

function modelSupportsThinking(provider: string, modelId: string): boolean {
  const entry = getModelsForProvider(provider).find((m) => m.id === modelId);
  if (entry?.supportsThinking !== undefined) return entry.supportsThinking;

  if (provider === "anthropic") return true;
  if (provider === "openrouter") return knownOpenRouterReasoningModel(modelId);
  return false;
}

/**
 * Permissive client-side fallback for the vision-capability check used when
 * the daemon config API hasn't surfaced a `supportsVision` value yet (e.g.
 * config response still loading, daemon catalog not yet exposing the field).
 * The runtime value from `useActiveProfileModel` is the source of truth —
 * this only runs when that value is `undefined`.
 *
 * The bundled `LlmCatalogModel` deliberately omits `supportsVision` so the
 * platform doesn't have to regenerate the catalog every time the daemon's
 * model capabilities change. As a result this helper has no provider/model
 * knowledge today and simply returns `true` — i.e., fail-open so legitimate
 * attachment flows aren't blocked when the daemon is unreachable.
 */
// Parameters kept for forward-compat: a future fallback could special-case
// well-known non-vision providers without depending on a synced catalog.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function modelSupportsVision(provider: string, modelId: string): boolean {
  return true;
}

function supportsEffort(provider: string, modelId: string, supportsThinking: boolean): boolean {
  if (provider === "anthropic") {
    return !modelId.includes("haiku") && supportsThinking;
  }
  if (provider === "openai") {
    return isOpenAIGPT5Family(modelId);
  }
  if (provider === "openrouter") {
    if (isOpenRouterAnthropicModel(modelId)) {
      return !modelId.includes("haiku") && supportsThinking;
    }
    return supportsThinking;
  }
  if (provider === "fireworks") {
    return supportsThinking;
  }
  return false;
}

export function resolveProfileParamVisibility(
  provider: string,
  model: string,
): ProfileParamVisibility {
  if (!provider || !model) return VISIBILITY_NONE;

  const providerId = provider.toLowerCase();
  const modelId = model.toLowerCase();
  const usesAnthropicWire =
    providerId === "anthropic" || (providerId === "openrouter" && isOpenRouterAnthropicModel(modelId));
  const supportsThinkingResult = modelSupportsThinking(providerId, modelId);

  return {
    maxTokens: true,
    contextWindow: true,
    effort: supportsEffort(providerId, modelId, supportsThinkingResult),
    speed: providerId === "anthropic" && modelId.includes("opus"),
    verbosity: providerId === "openai" && isOpenAIGPT5Family(modelId),
    temperature: usesAnthropicWire,
    thinking: (providerId === "anthropic" || providerId === "openrouter") && supportsThinkingResult,
  };
}
