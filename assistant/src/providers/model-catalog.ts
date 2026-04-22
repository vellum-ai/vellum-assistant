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
          inputPer1mTokens: 5,
          outputPer1mTokens: 25,
          cacheWritePer1mTokens: 6.25,
          cacheReadPer1mTokens: 0.5,
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
          inputPer1mTokens: 5,
          outputPer1mTokens: 25,
          cacheWritePer1mTokens: 6.25,
          cacheReadPer1mTokens: 0.5,
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
          outputPer1mTokens: 15.0,
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
          inputPer1mTokens: 1.75,
          outputPer1mTokens: 14.0,
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
          outputPer1mTokens: 3.0,
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
          inputPer1mTokens: 0.2,
          outputPer1mTokens: 1.25,
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
          inputPer1mTokens: 0.15,
          outputPer1mTokens: 0.6,
          cacheReadPer1mTokens: 0.0375,
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
          inputPer1mTokens: 0.02,
          outputPer1mTokens: 0.1,
          cacheReadPer1mTokens: 0.005,
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
      {
        id: "llama3.2",
        displayName: "Llama 3.2",
        contextWindowTokens: 128000,
        maxOutputTokens: 4096,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
      },
      {
        id: "mistral",
        displayName: "Mistral",
        contextWindowTokens: 32768,
        maxOutputTokens: 4096,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
      },
    ],
    defaultModel: "llama3.2",
    subtitle: "Run local models via Ollama. No API key required.",
    setupMode: "keyless",
    setupHint: "Install Ollama locally and pull the models you want to use.",
    credentialsGuide: {
      description:
        "Download and install Ollama, then pull models via `ollama pull <model>`.",
      url: "https://ollama.com/download",
      linkLabel: "Download Ollama",
    },
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    subtitle:
      "Open-source models served by Fireworks. Requires a Fireworks API key.",
    setupMode: "api-key",
    setupHint: "Enter your Fireworks API key to enable open-source models.",
    envVar: "FIREWORKS_API_KEY",
    credentialsGuide: {
      description: "Sign in to the Fireworks dashboard and create an API key.",
      url: "https://fireworks.ai/account/api-keys",
      linkLabel: "Open Fireworks Dashboard",
    },
    models: [
      {
        id: "accounts/fireworks/models/kimi-k2p5",
        displayName: "Kimi K2.5",
        contextWindowTokens: 256000,
        maxOutputTokens: 32768,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.6,
          outputPer1mTokens: 2.5,
        },
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
      // OpenRouter proxies anthropic/* through Anthropic's Messages API, so
      // prompt caching and cache TTL metadata pass through unchanged and
      // billing matches Anthropic's direct rates.
      {
        id: "anthropic/claude-opus-4.7",
        displayName: "Claude Opus 4.7",
        contextWindowTokens: 200000,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 5,
          outputPer1mTokens: 25,
          cacheWritePer1mTokens: 6.25,
          cacheReadPer1mTokens: 0.5,
        },
      },
      {
        id: "anthropic/claude-opus-4.6",
        displayName: "Claude Opus 4.6",
        contextWindowTokens: 200000,
        maxOutputTokens: 32000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 5,
          outputPer1mTokens: 25,
          cacheWritePer1mTokens: 6.25,
          cacheReadPer1mTokens: 0.5,
        },
      },
      {
        id: "anthropic/claude-sonnet-4.6",
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
        id: "anthropic/claude-haiku-4.5",
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
        id: "moonshotai/kimi-k2.6",
        displayName: "Kimi K2.6",
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.6, outputPer1mTokens: 2.8 },
      },
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
