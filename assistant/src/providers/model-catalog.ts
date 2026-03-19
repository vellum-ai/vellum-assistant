export interface CatalogModel {
  id: string;
  displayName: string;
}

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  models: CatalogModel[];
  defaultModel: string;
  apiKeyUrl?: string;
  apiKeyPlaceholder?: string;
}

/** Single source of truth for all inference provider metadata and models. */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    models: [
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
    ],
    defaultModel: "claude-opus-4-6",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "sk-ant-api03-...",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    models: [
      { id: "gpt-5.4", displayName: "GPT-5.4" },
      { id: "gpt-5.2", displayName: "GPT-5.2" },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" },
      { id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano" },
    ],
    defaultModel: "gpt-5.4",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-proj-...",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    models: [
      { id: "gemini-3-flash", displayName: "Gemini 3 Flash" },
      { id: "gemini-3-pro", displayName: "Gemini 3 Pro" },
    ],
    defaultModel: "gemini-3-flash",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    apiKeyPlaceholder: "AIza...",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    models: [
      { id: "llama3.2", displayName: "Llama 3.2" },
      { id: "mistral", displayName: "Mistral" },
    ],
    defaultModel: "llama3.2",
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    models: [
      {
        id: "accounts/fireworks/models/kimi-k2p5",
        displayName: "Kimi K2.5",
      },
    ],
    defaultModel: "accounts/fireworks/models/kimi-k2p5",
    apiKeyUrl: "https://fireworks.ai/account/api-keys",
    apiKeyPlaceholder: "fw_...",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    models: [
      { id: "x-ai/grok-4", displayName: "Grok 4" },
      { id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta" },
    ],
    defaultModel: "x-ai/grok-4",
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyPlaceholder: "sk-or-v1-...",
  },
];

/** Check if a model ID is in the catalog for a given provider. */
export function isModelInCatalog(provider: string, modelId: string): boolean {
  const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
  return entry?.models.some((m) => m.id === modelId) ?? false;
}
