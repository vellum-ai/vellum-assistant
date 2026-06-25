/**
 * Determines which advanced parameter controls to show in ProfileEditorModal
 * based on the selected provider and model.
 */

import { getModelsForProvider, type LlmCatalogModel } from "@/assistant/llm-model-catalog";

export interface ProfileParamVisibility {
  maxTokens: boolean;
  contextWindow: boolean;
  effort: boolean;
  speed: boolean;
  verbosity: boolean;
  temperature: boolean;
  topP: boolean;
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
  topP: false,
  thinking: false,
  thinkingLevel: false,
};

function isOpenAIGPT5Family(modelId: string): boolean {
  return modelId === "gpt-5" || modelId.startsWith("gpt-5.") || modelId.startsWith("gpt-5-");
}

function isOpenRouterAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}

/**
 * Case-insensitive exact-id catalog lookup. `resolveProfileParamVisibility`
 * lowercases the model id for its prefix/substring heuristics, but catalog
 * ids can be mixed-case (e.g. minimax's "MiniMax-M3"), so an exact `===`
 * find would never match those entries.
 */
function findCatalogModel(provider: string, modelId: string): LlmCatalogModel | undefined {
  const id = modelId.toLowerCase();
  return getModelsForProvider(provider).find((m) => m.id.toLowerCase() === id);
}

/**
 * Models flagged `adaptiveThinkingOnly` in the catalog always reason with
 * adaptive (always-on) thinking and reject an explicit "disable thinking"
 * request, so the enable/disable toggle must not be shown — effort stays
 * adjustable. Mirrors the daemon's `isAdaptiveThinkingOnlyModel` in
 * `assistant/src/providers/model-catalog.ts`.
 */
function isAdaptiveThinkingOnlyModel(provider: string, modelId: string): boolean {
  return findCatalogModel(provider, modelId)?.adaptiveThinkingOnly === true;
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
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS_FULL)[number];

const GEMINI_THINKING_LEVELS_SET: ReadonlySet<string> = new Set(GEMINI_THINKING_LEVELS_FULL);

export function isGeminiThinkingLevel(v: unknown): v is GeminiThinkingLevel {
  return typeof v === "string" && GEMINI_THINKING_LEVELS_SET.has(v);
}

export function geminiThinkingLevels(modelId: string): readonly GeminiThinkingLevel[] {
  return isGeminiProModel(modelId.toLowerCase())
    ? GEMINI_THINKING_LEVELS_PRO
    : GEMINI_THINKING_LEVELS_FULL;
}

/**
 * Whether a model supports extended thinking, preferring the catalog's
 * `supportsThinking` flag over per-provider heuristics. `provider` must be a
 * lowercase provider id. Exported for tests.
 */
export function modelSupportsThinking(provider: string, modelId: string): boolean {
  const entry = findCatalogModel(provider, modelId);
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
  if (provider === "together") {
    return supportsThinking;
  }
  return false;
}

// Native `openai` is intentionally excluded: it uses the Responses API, which
// doesn't forward sampling params — reasoning models reject `top_p`/`temperature`
// with HTTP 400, and resolved `effort` defaults to a reasoning effort, so the
// control would silently no-op. This mirrors how `temperature` is gated to the
// Anthropic wire only. OpenAI-compatible connections use the chat-completions
// client, which forwards `top_p`.
const TOP_P_OPENAI_COMPAT_PROVIDERS = new Set([
  "openai-compatible",
  "fireworks",
  "minimax",
  "atlascloud",
  "ollama",
  "openrouter",
  "together",
]);

/**
 * `topP` is gated to providers whose clients actually forward it: the Anthropic
 * wire and OpenAI-compatible providers (which use the chat-completions client).
 * Native `openai` (Responses API) and Gemini are excluded — neither forwards
 * `top_p`.
 */
function supportsTopP(providerId: string, usesAnthropicWire: boolean): boolean {
  return usesAnthropicWire || TOP_P_OPENAI_COMPAT_PROVIDERS.has(providerId);
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
    topP: supportsTopP(providerId, usesAnthropicWire),
    thinking:
      (providerId === "anthropic" || providerId === "openrouter") &&
      supportsThinkingResult &&
      !isAdaptiveThinkingOnlyModel(providerId, modelId),
    thinkingLevel: providerId === "gemini" && supportsThinkingResult,
  };
}
