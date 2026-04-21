export interface CatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportsCaching?: boolean;
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  pricing?: {
    inputPer1mTokens: number;
    outputPer1mTokens: number;
    cacheWritePer1mTokens?: number;
    cacheReadPer1mTokens?: number;
  };
}

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  models: CatalogModel[];
  defaultModel: string;
  apiKeyUrl?: string;
  apiKeyPlaceholder?: string;
  subtitle?: string;
  setupMode?: "api-key" | "keyless";
  setupHint?: string;
  envVar?: string;
  credentialsGuide?: {
    description: string;
    url: string;
    linkLabel: string;
  };
}

/** Single source of truth for all inference provider metadata and models. */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    models: [
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
    ],
    defaultModel: "claude-opus-4-7",
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
      { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" },
      { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
    ],
    defaultModel: "gemini-2.5-flash",
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
    subtitle: "Route to many LLM providers via a single OpenRouter API key.",
    setupMode: "api-key",
    setupHint: "Enter your OpenRouter API key to access multiple models.",
    envVar: "OPENROUTER_API_KEY",
    credentialsGuide: {
      description: "Sign in to OpenRouter and create an API key.",
      url: "https://openrouter.ai/keys",
      linkLabel: "Open OpenRouter",
    },
    models: [
      // Anthropic
      {
        id: "anthropic/claude-opus-4.7",
        displayName: "Claude Opus 4.7",
        contextWindowTokens: 200000,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 15, outputPer1mTokens: 75 },
      },
      {
        id: "anthropic/claude-opus-4.6",
        displayName: "Claude Opus 4.6",
        contextWindowTokens: 200000,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 15, outputPer1mTokens: 75 },
      },
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 3, outputPer1mTokens: 15 },
      },
      {
        id: "anthropic/claude-haiku-4.5",
        displayName: "Claude Haiku 4.5",
        contextWindowTokens: 200000,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 1, outputPer1mTokens: 5 },
      },
      // xAI
      {
        id: "x-ai/grok-4.20-beta",
        displayName: "Grok 4.20 Beta",
        contextWindowTokens: 256000,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 3, outputPer1mTokens: 15 },
      },
      {
        id: "x-ai/grok-4",
        displayName: "Grok 4",
        contextWindowTokens: 131072,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 3, outputPer1mTokens: 15 },
      },
      // DeepSeek
      {
        id: "deepseek/deepseek-r1-0528",
        displayName: "DeepSeek R1",
        contextWindowTokens: 163840,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.55, outputPer1mTokens: 2.19 },
      },
      {
        id: "deepseek/deepseek-chat-v3-0324",
        displayName: "DeepSeek V3",
        contextWindowTokens: 163840,
        maxOutputTokens: 32000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.27, outputPer1mTokens: 1.1 },
      },
      // Qwen
      {
        id: "qwen/qwen3.5-plus-02-15",
        displayName: "Qwen 3.5 Plus",
        contextWindowTokens: 131072,
        maxOutputTokens: 8192,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.8, outputPer1mTokens: 2.4 },
      },
      {
        id: "qwen/qwen3.5-397b-a17b",
        displayName: "Qwen 3.5 397B",
        contextWindowTokens: 131072,
        maxOutputTokens: 8192,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.9, outputPer1mTokens: 2.7 },
      },
      {
        id: "qwen/qwen3.5-flash-02-23",
        displayName: "Qwen 3.5 Flash",
        contextWindowTokens: 131072,
        maxOutputTokens: 8192,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.2, outputPer1mTokens: 0.6 },
      },
      {
        id: "qwen/qwen3-coder-next",
        displayName: "Qwen 3 Coder",
        contextWindowTokens: 131072,
        maxOutputTokens: 8192,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.5, outputPer1mTokens: 1.5 },
      },
      // Moonshot
      {
        id: "moonshotai/kimi-k2.5",
        displayName: "Kimi K2.5",
        contextWindowTokens: 256000,
        maxOutputTokens: 32768,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.6, outputPer1mTokens: 2.5 },
      },
      // Mistral
      {
        id: "mistralai/mistral-medium-3",
        displayName: "Mistral Medium 3",
        contextWindowTokens: 131072,
        maxOutputTokens: 16000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.4, outputPer1mTokens: 2.0 },
      },
      {
        id: "mistralai/mistral-small-2603",
        displayName: "Mistral Small 4",
        contextWindowTokens: 131072,
        maxOutputTokens: 16000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.2, outputPer1mTokens: 0.6 },
      },
      {
        id: "mistralai/devstral-2512",
        displayName: "Devstral 2",
        contextWindowTokens: 131072,
        maxOutputTokens: 16000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.1, outputPer1mTokens: 0.3 },
      },
      // Meta
      {
        id: "meta-llama/llama-4-maverick",
        displayName: "Llama 4 Maverick",
        contextWindowTokens: 1000000,
        maxOutputTokens: 16000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.27, outputPer1mTokens: 0.85 },
      },
      {
        id: "meta-llama/llama-4-scout",
        displayName: "Llama 4 Scout",
        contextWindowTokens: 327680,
        maxOutputTokens: 16000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.11, outputPer1mTokens: 0.34 },
      },
      // Amazon
      {
        id: "amazon/nova-pro-v1",
        displayName: "Amazon Nova Pro",
        contextWindowTokens: 300000,
        maxOutputTokens: 5000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.8, outputPer1mTokens: 3.2 },
      },
    ],
    defaultModel: "x-ai/grok-4.20-beta",
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyPlaceholder: "sk-or-v1-...",
  },
];

/** Check if a model ID is in the catalog for a given provider. */
export function isModelInCatalog(provider: string, modelId: string): boolean {
  const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
  return entry?.models.some((m) => m.id === modelId) ?? false;
}
