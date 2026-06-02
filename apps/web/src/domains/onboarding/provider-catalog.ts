// Trimmed model-provider catalog for the onboarding "Connect a Model Provider"
// step. Ported from the daemon/macOS catalog
// (clients/shared/Resources/llm-provider-catalog.json), limited to the
// providers the web daemon client supports (see ConnectionProvider in
// domains/settings) and to the fields the onboarding UI needs.

export type OnboardingProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "fireworks"
  | "openrouter"
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
}

export const ONBOARDING_PROVIDERS: readonly OnboardingProvider[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    apiKeyPlaceholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    requiresKey: true,
  },
  {
    id: "openai",
    displayName: "OpenAI",
    apiKeyPlaceholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    requiresKey: true,
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    apiKeyPlaceholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    requiresKey: true,
  },
  {
    id: "ollama",
    displayName: "Ollama",
    apiKeyPlaceholder: null,
    docsUrl: "https://ollama.com/download",
    requiresKey: false,
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    apiKeyPlaceholder: "fw_...",
    docsUrl: "https://fireworks.ai/account/api-keys",
    requiresKey: true,
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    apiKeyPlaceholder: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
    requiresKey: true,
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible",
    apiKeyPlaceholder: "Your provider's API key",
    docsUrl: null,
    requiresKey: true,
  },
];

export const DEFAULT_ONBOARDING_PROVIDER = ONBOARDING_PROVIDERS[0];

export function onboardingProvider(
  id: string,
): OnboardingProvider | undefined {
  return ONBOARDING_PROVIDERS.find((p) => p.id === id);
}
