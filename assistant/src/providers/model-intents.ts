import { isModelInCatalog, PROVIDER_CATALOG } from "./model-catalog.js";
import { isCodexSubscriptionModel } from "./openai/codex-models.js";
import type { ModelIntent } from "./types.js";

/**
 * Derived from PROVIDER_CATALOG — single source of truth for default models.
 * Each provider's `defaultModel` in the catalog populates this map.
 */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry.defaultModel]),
);

// `cost-optimized` is the cheapest model a provider serves, `latency-optimized`
// the fastest to first token. On anthropic, ollama, fireworks and openai the
// same model is both, so those columns repeat by construction rather than by
// oversight (openai's balanced repeats it too: the default-profile templates
// split those tiers by reasoning effort, not model).
const PROVIDER_MODEL_INTENTS: Record<string, Record<ModelIntent, string>> = {
  anthropic: {
    balanced: "claude-sonnet-4-6",
    "cost-optimized": "claude-haiku-4-5-20251001",
    "latency-optimized": "claude-haiku-4-5-20251001",
    "quality-optimized": "claude-fable-5",
    "vision-optimized": "claude-opus-4-6",
  },
  openai: {
    balanced: "gpt-5.6-luna",
    "cost-optimized": "gpt-5.6-luna",
    "latency-optimized": "gpt-5.6-luna",
    "quality-optimized": "gpt-5.6-sol",
    "vision-optimized": "gpt-5.6-terra",
  },
  gemini: {
    balanced: "gemini-3-flash-preview",
    "cost-optimized": "gemini-2.5-flash-lite",
    "latency-optimized": "gemini-3.1-flash-lite",
    "quality-optimized": "gemini-3.1-pro-preview",
    "vision-optimized": "gemini-3-flash-preview",
  },
  ollama: {
    balanced: "llama3.2",
    "cost-optimized": "llama3.2",
    "latency-optimized": "llama3.2",
    "quality-optimized": "llama3.2",
    "vision-optimized": "llama3.2",
  },
  fireworks: {
    balanced: "accounts/fireworks/models/minimax-m3",
    "cost-optimized": "accounts/fireworks/models/deepseek-v4-flash",
    "latency-optimized": "accounts/fireworks/models/deepseek-v4-flash",
    "quality-optimized": "accounts/fireworks/models/kimi-k2p6",
    "vision-optimized": "accounts/fireworks/models/kimi-k2p6",
  },
  openrouter: {
    balanced: "anthropic/claude-sonnet-4.6",
    "cost-optimized": "deepseek/deepseek-v4-flash",
    "latency-optimized": "anthropic/claude-haiku-4.5",
    "quality-optimized": "anthropic/claude-fable-5",
    "vision-optimized": "anthropic/claude-opus-4.6",
  },
  "vercel-ai-gateway": {
    balanced: "anthropic/claude-sonnet-4.6",
    "cost-optimized": "deepseek/deepseek-v4-flash",
    "latency-optimized": "anthropic/claude-haiku-4.5",
    "quality-optimized": "anthropic/claude-fable-5",
    "vision-optimized": "anthropic/claude-opus-4.6",
  },
};

const FALLBACK_DEFAULT_MODEL = "claude-opus-4-8";

const MODEL_INTENTS = new Set<ModelIntent>([
  "balanced",
  "cost-optimized",
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

// The openai column must additionally stay inside the ChatGPT Codex
// subscription set: the subscription default provider is stored as
// `llm.defaultProvider = { provider: "openai", connectionName:
// "chatgpt-subscription" }`, so the materialized default profiles resolve
// through this column while pinning the subscription connection, which
// bypasses the auto-resolution compat gate and hard-routes to the Codex
// endpoint, where a non-Codex model 400s on every request.
for (const [intent, modelId] of Object.entries(PROVIDER_MODEL_INTENTS.openai)) {
  if (!isCodexSubscriptionModel(modelId)) {
    throw new Error(
      `PROVIDER_MODEL_INTENTS[openai][${intent}] references model "${modelId}" ` +
        `which the ChatGPT subscription cannot serve. Pick a model from ` +
        `CODEX_SUBSCRIPTION_MODEL_IDS in openai/codex-models.ts.`,
    );
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
