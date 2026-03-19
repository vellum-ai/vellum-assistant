export interface CatalogModel {
  id: string;
  displayName: string;
}

export const PROVIDER_MODEL_CATALOG: Record<string, CatalogModel[]> = {
  anthropic: [
    { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5.4", displayName: "GPT-5.4" },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
    { id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano" },
  ],
  gemini: [
    { id: "gemini-3-flash", displayName: "Gemini 3 Flash" },
    { id: "gemini-3-pro", displayName: "Gemini 3 Pro" },
  ],
  ollama: [
    { id: "llama3.2", displayName: "Llama 3.2" },
    { id: "mistral", displayName: "Mistral" },
  ],
  fireworks: [
    { id: "accounts/fireworks/models/kimi-k2p5", displayName: "Kimi K2.5" },
  ],
  openrouter: [
    { id: "x-ai/grok-4", displayName: "Grok 4" },
    { id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta" },
  ],
};

/** Display names for inference providers */
export const INFERENCE_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama",
  fireworks: "Fireworks",
  openrouter: "OpenRouter",
};

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  models: CatalogModel[];
  defaultModel: string;
}

/** Build the full provider catalog with metadata for each inference provider. */
export function getFullProviderCatalog(): ProviderCatalogEntry[] {
  return Object.entries(PROVIDER_MODEL_CATALOG).map(([id, models]) => ({
    id,
    displayName: INFERENCE_PROVIDER_DISPLAY_NAMES[id] ?? id,
    models,
    defaultModel: models[0]?.id ?? "",
  }));
}

/** Check if a model ID is in the catalog for a given provider */
export function isModelInCatalog(provider: string, modelId: string): boolean {
  const catalog = PROVIDER_MODEL_CATALOG[provider];
  return catalog?.some((m) => m.id === modelId) ?? false;
}
