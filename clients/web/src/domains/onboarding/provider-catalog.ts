// Trimmed model-provider catalog for the onboarding "Connect a Model Provider"
// step. Limited to the providers the web daemon client supports (see
// ConnectionProvider in domains/settings) and to the fields the onboarding
// UI needs.

export type OnboardingProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "fireworks"
  | "openrouter"
  | "vercel-ai-gateway"
  | "openai-compatible";

export interface OnboardingProvider {
  readonly id: OnboardingProviderId;
  readonly displayName: string;
  /** Placeholder for the API-key input; null for keyless providers. */
  readonly apiKeyPlaceholder: string | null;
  /** "Get an API key here" docs URL; null when the provider has none. */
  readonly docsUrl: string | null;
  /** Whether an API key is required before the user can continue. */
  readonly requiresKey: boolean;
  /** Balanced model used for the initial local assistant profile. */
  readonly defaultModel?: string;
  readonly models?: readonly OnboardingModel[];
}

export interface OnboardingModel {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export const ONBOARDING_PROVIDERS: readonly OnboardingProvider[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    apiKeyPlaceholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    requiresKey: true,
    defaultModel: "claude-sonnet-4-6",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    apiKeyPlaceholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    requiresKey: true,
    defaultModel: "gpt-5.4-mini",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    apiKeyPlaceholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    requiresKey: true,
    defaultModel: "gemini-3-flash-preview",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    apiKeyPlaceholder: null,
    docsUrl: "https://ollama.com/download",
    requiresKey: false,
    defaultModel: "llama3.2",
    models: [
      {
        id: "llama3.2",
        displayName: "Llama 3.2",
        contextWindowTokens: 128_000,
        maxOutputTokens: 4_096,
      },
      {
        id: "mistral",
        displayName: "Mistral",
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ],
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    apiKeyPlaceholder: "fw_...",
    docsUrl: "https://fireworks.ai/account/api-keys",
    requiresKey: true,
    defaultModel: "accounts/fireworks/models/minimax-m3",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    apiKeyPlaceholder: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
    requiresKey: true,
    defaultModel: "anthropic/claude-sonnet-4.6",
    models: [
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
      },
      {
        id: "anthropic/claude-opus-4.8",
        displayName: "Claude Opus 4.8",
        contextWindowTokens: 200_000,
        maxOutputTokens: 128_000,
      },
      {
        id: "x-ai/grok-4.20-beta",
        displayName: "Grok 4.20 Beta",
        contextWindowTokens: 200_000,
        maxOutputTokens: 16_000,
      },
      {
        id: "deepseek/deepseek-r1-0528",
        displayName: "DeepSeek R1",
        contextWindowTokens: 163_840,
        maxOutputTokens: 32_000,
      },
    ],
  },
  {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    apiKeyPlaceholder: "vck_...",
    docsUrl:
      "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys",
    requiresKey: true,
    defaultModel: "anthropic/claude-sonnet-4.6",
    models: [
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 64_000,
      },
      {
        id: "anthropic/claude-opus-4.8",
        displayName: "Claude Opus 4.8",
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 128_000,
      },
      {
        id: "xai/grok-4.3",
        displayName: "Grok 4.3",
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 16_000,
      },
      {
        id: "deepseek/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 384_000,
      },
    ],
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible",
    apiKeyPlaceholder: "Your provider's API key (optional)",
    docsUrl: null,
    requiresKey: true,
  },
];

export const DEFAULT_ONBOARDING_PROVIDER = ONBOARDING_PROVIDERS[0];

export function onboardingProvider(id: string): OnboardingProvider | undefined {
  return ONBOARDING_PROVIDERS.find((p) => p.id === id);
}

export function defaultModelForOnboardingProvider(
  id: OnboardingProviderId,
): string | undefined {
  const provider = onboardingProvider(id);
  return provider?.defaultModel ?? provider?.models?.[0]?.id;
}
