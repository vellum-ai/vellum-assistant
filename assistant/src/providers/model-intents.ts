import type { ModelIntent } from "./types.js";

const PROVIDER_DEFAULT_MODELS = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.2",
  gemini: "gemini-3-flash",
  ollama: "llama3.2",
  fireworks: "accounts/fireworks/models/kimi-k2p5",
  openrouter: "x-ai/grok-4",
} as const;

type KnownProviderName = keyof typeof PROVIDER_DEFAULT_MODELS;

const PROVIDER_MODEL_INTENTS: Record<
  KnownProviderName,
  Record<ModelIntent, string>
> = {
  anthropic: {
    "latency-optimized": "claude-haiku-4-5-20251001",
    "quality-optimized": "claude-opus-4-6",
    "vision-optimized": "claude-sonnet-4-6",
  },
  openai: {
    "latency-optimized": "gpt-5.4-nano",
    "quality-optimized": "gpt-5.2",
    "vision-optimized": "gpt-5.4",
  },
  gemini: {
    "latency-optimized": "gemini-3-flash",
    "quality-optimized": "gemini-3-flash",
    "vision-optimized": "gemini-3-flash",
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
    "latency-optimized": "x-ai/grok-4",
    "quality-optimized": "x-ai/grok-4.20-beta",
    "vision-optimized": "x-ai/grok-4",
  },
};

const MODEL_INTENTS = new Set<ModelIntent>([
  "latency-optimized",
  "quality-optimized",
  "vision-optimized",
]);

export function isModelIntent(value: unknown): value is ModelIntent {
  return typeof value === "string" && MODEL_INTENTS.has(value as ModelIntent);
}

export function getProviderDefaultModel(providerName: string): string {
  const knownProvider = providerName as KnownProviderName;
  return (
    PROVIDER_DEFAULT_MODELS[knownProvider] ?? PROVIDER_DEFAULT_MODELS.anthropic
  );
}

export function resolveModelIntent(
  providerName: string,
  intent: ModelIntent,
): string {
  const knownProvider = providerName as KnownProviderName;
  const providerIntentModels = PROVIDER_MODEL_INTENTS[knownProvider];
  if (providerIntentModels) {
    return providerIntentModels[intent];
  }
  return getProviderDefaultModel(providerName);
}
