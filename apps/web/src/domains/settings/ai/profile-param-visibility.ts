/**
 * Determines which advanced parameter controls to show in ProfileEditorModal
 * based on the selected provider and model.
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
  /** Gemini's reasoning-depth knob (`thinking.level`). Distinct from `thinking`
   * (Anthropic/OpenRouter enable + stream toggles) — Gemini uses a level. */
  thinkingLevel: boolean;
}

export const VISIBILITY_NONE: ProfileParamVisibility = {
  maxTokens: false,
  contextWindow: false,
  effort: false,
  speed: false,
  verbosity: false,
  temperature: false,
  thinking: false,
  thinkingLevel: false,
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

const GEMINI_THINKING_LEVELS_FULL = ["minimal", "low", "medium", "high"] as const;
const GEMINI_THINKING_LEVELS_PRO = ["low", "medium", "high"] as const;

/**
 * Gemini 3.x Pro family accepts only low/medium/high (no "minimal") and cannot
 * disable thinking. Mirrors the daemon's `isGeminiProModel` in
 * `assistant/src/providers/gemini/client.ts`.
 */
function isGeminiProModel(modelId: string): boolean {
  return /^gemini-3.*pro/.test(modelId);
}

/**
 * Thinking levels selectable for a Gemini model, lowest → highest. Pro models
 * omit "minimal". The daemon clamps anything below a model's floor, so this is
 * a UX nicety rather than a correctness guarantee.
 */
export function geminiThinkingLevels(modelId: string): readonly string[] {
  return isGeminiProModel(modelId.toLowerCase())
    ? GEMINI_THINKING_LEVELS_PRO
    : GEMINI_THINKING_LEVELS_FULL;
}

function modelSupportsThinking(provider: string, modelId: string): boolean {
  const entry = getModelsForProvider(provider).find((m) => m.id === modelId);
  if (entry?.supportsThinking !== undefined) return entry.supportsThinking;

  if (provider === "anthropic") return true;
  if (provider === "openrouter") return knownOpenRouterReasoningModel(modelId);
  return false;
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
    thinkingLevel: providerId === "gemini" && supportsThinkingResult,
  };
}
