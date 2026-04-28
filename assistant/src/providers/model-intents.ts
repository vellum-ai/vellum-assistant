import { isModelInCatalog, PROVIDER_CATALOG } from "./model-catalog.js";
import type { ModelIntent } from "./types.js";

/**
 * Derived from PROVIDER_CATALOG — single source of truth for default models.
 * Each provider's `defaultModel` in the catalog populates this map.
 */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry.defaultModel]),
);

const PROVIDER_MODEL_INTENTS: Record<string, Record<ModelIntent, string>> = {
  anthropic: {
    "latency-optimized": "claude-haiku-4-5-20251001",
    "quality-optimized": "claude-opus-4-7",
    "vision-optimized": "claude-opus-4-6",
  },
  openai: {
    "latency-optimized": "gpt-5.4-nano",
    "quality-optimized": "gpt-5.4",
    "vision-optimized": "gpt-5.4",
  },
  gemini: {
    "latency-optimized": "gemini-3.1-flash-lite-preview",
    "quality-optimized": "gemini-3.1-pro-preview",
    "vision-optimized": "gemini-3-flash-preview",
  },
  ollama: {
    "latency-optimized": "llama3.2",
    "quality-optimized": "llama3.2",
    "vision-optimized": "llama3.2",
  },
  fireworks: {
    "latency-optimized": "accounts/fireworks/models/kimi-k2p5",
    "quality-optimized": "accounts/fireworks/models/kimi-k2p5",
    "vision-optimized": "accounts/fireworks/models/kimi-k2p5",
  },
  openrouter: {
    "latency-optimized": "anthropic/claude-haiku-4.5",
    "quality-optimized": "anthropic/claude-opus-4.7",
    "vision-optimized": "anthropic/claude-opus-4.6",
  },
};

const FALLBACK_DEFAULT_MODEL = "claude-opus-4-7";

const MODEL_INTENTS = new Set<ModelIntent>([
  "latency-optimized",
  "quality-optimized",
  "vision-optimized",
]);

// ── Consistency validation ───────────────────────────────────────────
// Eagerly verify that every model ID referenced by PROVIDER_MODEL_INTENTS
// exists in PROVIDER_CATALOG, catching drift at module-load time rather
// than at runtime when a user picks a model.
for (const [provider, intents] of Object.entries(PROVIDER_MODEL_INTENTS)) {
  for (const [intent, modelId] of Object.entries(intents)) {
    if (!isModelInCatalog(provider, modelId)) {
      throw new Error(
        `PROVIDER_MODEL_INTENTS[${provider}][${intent}] references model "${modelId}" ` +
          `which is not in PROVIDER_CATALOG. Update model-catalog.ts or model-intents.ts.`,
      );
    }
  }
}

export function isModelIntent(value: unknown): value is ModelIntent {
  return typeof value === "string" && MODEL_INTENTS.has(value as ModelIntent);
}

export function getProviderDefaultModel(providerName: string): string {
  return PROVIDER_DEFAULT_MODELS[providerName] ?? FALLBACK_DEFAULT_MODEL;
}

export function resolveModelIntent(
  providerName: string,
  intent: ModelIntent,
): string {
  const providerIntentModels = PROVIDER_MODEL_INTENTS[providerName];
  if (providerIntentModels) {
    return providerIntentModels[intent];
  }
  return getProviderDefaultModel(providerName);
}
