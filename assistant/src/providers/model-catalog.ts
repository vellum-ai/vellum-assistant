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
    subtitle: "Claude models from Anthropic. Requires an Anthropic API key.",
    setupMode: "api-key",
    setupHint: "Enter your Anthropic API key to enable Claude.",
    envVar: "ANTHROPIC_API_KEY",
    credentialsGuide: {
      description:
        "Sign in to the Anthropic Console, navigate to API Keys, and create a new key.",
      url: "https://console.anthropic.com/settings/keys",
      linkLabel: "Open Anthropic Console",
    },
    models: [
      {
        id: "claude-opus-4-7",
        displayName: "Claude Opus 4.7",
        contextWindowTokens: 200000,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 15,
          outputPer1mTokens: 75,
          cacheWritePer1mTokens: 18.75,
          cacheReadPer1mTokens: 1.5,
        },
      },
      {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        contextWindowTokens: 200000,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 15,
          outputPer1mTokens: 75,
          cacheWritePer1mTokens: 18.75,
          cacheReadPer1mTokens: 1.5,
        },
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 3,
          outputPer1mTokens: 15,
          cacheWritePer1mTokens: 3.75,
          cacheReadPer1mTokens: 0.3,
        },
      },
      {
        id: "claude-haiku-4-5-20251001",
        displayName: "Claude Haiku 4.5",
        contextWindowTokens: 200000,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1,
          outputPer1mTokens: 5,
          cacheWritePer1mTokens: 1.25,
          cacheReadPer1mTokens: 0.1,
        },
      },
    ],
    defaultModel: "claude-opus-4-7",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "sk-ant-api03-...",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    subtitle: "GPT models from OpenAI. Requires an OpenAI API key.",
    setupMode: "api-key",
    setupHint: "Enter your OpenAI API key to enable GPT.",
    envVar: "OPENAI_API_KEY",
    credentialsGuide: {
      description:
        "Log in to the OpenAI platform, go to API Keys, and generate a new secret key.",
      url: "https://platform.openai.com/api-keys",
      linkLabel: "Open OpenAI Platform",
    },
    models: [
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        contextWindowTokens: 400000,
        maxOutputTokens: 128000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 2.5,
          outputPer1mTokens: 10.0,
          cacheReadPer1mTokens: 0.25,
        },
      },
      {
        id: "gpt-5.2",
        displayName: "GPT-5.2",
        contextWindowTokens: 400000,
        maxOutputTokens: 128000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 3.0,
          outputPer1mTokens: 12.0,
          cacheReadPer1mTokens: 0.3,
        },
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        contextWindowTokens: 400000,
        maxOutputTokens: 128000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.5,
          outputPer1mTokens: 2.0,
          cacheReadPer1mTokens: 0.05,
        },
      },
      {
        id: "gpt-5.4-nano",
        displayName: "GPT-5.4 Nano",
        contextWindowTokens: 400000,
        maxOutputTokens: 128000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.1,
          outputPer1mTokens: 0.4,
          cacheReadPer1mTokens: 0.01,
        },
      },
    ],
    defaultModel: "gpt-5.4",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-proj-...",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    subtitle:
      "Multimodal Gemini models from Google. Requires a Gemini API key.",
    setupMode: "api-key",
    setupHint: "Enter your Gemini API key to enable Google models.",
    envVar: "GEMINI_API_KEY",
    credentialsGuide: {
      description:
        "Visit Google AI Studio, sign in with your Google account, and create an API key.",
      url: "https://aistudio.google.com/apikey",
      linkLabel: "Open Google AI Studio",
    },
    models: [
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        contextWindowTokens: 1000000,
        maxOutputTokens: 65536,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.3,
          outputPer1mTokens: 2.5,
          cacheReadPer1mTokens: 0.075,
        },
      },
      {
        id: "gemini-2.5-flash-lite",
        displayName: "Gemini 2.5 Flash Lite",
        contextWindowTokens: 1000000,
        maxOutputTokens: 65536,
        supportsThinking: false,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.1,
          outputPer1mTokens: 0.4,
          cacheReadPer1mTokens: 0.025,
        },
      },
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        contextWindowTokens: 2000000,
        maxOutputTokens: 65536,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1.25,
          outputPer1mTokens: 10.0,
          cacheReadPer1mTokens: 0.3125,
        },
      },
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
    models: [
      // Anthropic
      { id: "anthropic/claude-opus-4.7", displayName: "Claude Opus 4.7" },
      { id: "anthropic/claude-opus-4.6", displayName: "Claude Opus 4.6" },
      { id: "anthropic/claude-sonnet-4.6", displayName: "Claude Sonnet 4.6" },
      { id: "anthropic/claude-haiku-4.5", displayName: "Claude Haiku 4.5" },
      // xAI
      { id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta" },
      { id: "x-ai/grok-4", displayName: "Grok 4" },
      // DeepSeek
      { id: "deepseek/deepseek-r1-0528", displayName: "DeepSeek R1" },
      { id: "deepseek/deepseek-chat-v3-0324", displayName: "DeepSeek V3" },
      // Qwen
      { id: "qwen/qwen3.5-plus-02-15", displayName: "Qwen 3.5 Plus" },
      { id: "qwen/qwen3.5-397b-a17b", displayName: "Qwen 3.5 397B" },
      { id: "qwen/qwen3.5-flash-02-23", displayName: "Qwen 3.5 Flash" },
      { id: "qwen/qwen3-coder-next", displayName: "Qwen 3 Coder" },
      // Moonshot
      { id: "moonshotai/kimi-k2.5", displayName: "Kimi K2.5" },
      // Mistral
      { id: "mistralai/mistral-medium-3", displayName: "Mistral Medium 3" },
      { id: "mistralai/mistral-small-2603", displayName: "Mistral Small 4" },
      { id: "mistralai/devstral-2512", displayName: "Devstral 2" },
      // Meta
      { id: "meta-llama/llama-4-maverick", displayName: "Llama 4 Maverick" },
      { id: "meta-llama/llama-4-scout", displayName: "Llama 4 Scout" },
      // Amazon
      { id: "amazon/nova-pro-v1", displayName: "Amazon Nova Pro" },
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
