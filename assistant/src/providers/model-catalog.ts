/**
 * Per-model capability + pricing metadata for every provider/model we list.
 *
 * Values sourced from vendor documentation as of 2026-04-17; update together
 * with any model additions. Sources:
 *   - Anthropic:  https://docs.anthropic.com/en/docs/about-claude/models
 *                 https://www.anthropic.com/pricing#api
 *   - OpenAI:     https://platform.openai.com/docs/models
 *                 https://openai.com/api/pricing
 *   - Google:     https://ai.google.dev/gemini-api/docs/models
 *                 https://ai.google.dev/pricing
 *   - Fireworks:  https://fireworks.ai/models
 *                 https://fireworks.ai/pricing
 *   - Ollama:     self-hosted; no pricing, no prompt-cache sharing
 *   - OpenRouter: upstream provider docs (routes to upstream; mirror upstream
 *                 contextWindow / maxOutputTokens / caching where known)
 *
 * When a specific number could not be verified against vendor docs, a
 * conservative fallback is used and a `// TODO: verify` comment flags it.
 */
export interface CatalogModel {
  id: string;
  displayName: string;
  /** Maximum input tokens the model accepts. */
  contextWindow: number;
  /** Maximum output tokens the model will emit (per request). */
  maxOutputTokens: number;
  /** Whether the provider supports prompt-cache sharing on this model. */
  supportsPromptCaching: boolean;
  /** Optional — input cost per 1M tokens (USD). For usage accounting / dashboards. */
  inputCostPer1M?: number;
  /** Optional — output cost per 1M tokens (USD). */
  outputCostPer1M?: number;
  /** Optional — cache-read cost per 1M tokens (USD). */
  cacheReadCostPer1M?: number;
  /** Optional — cache-write cost per 1M tokens (5-minute TTL, Anthropic). */
  cacheWrite5mCostPer1M?: number;
  /** Optional — cache-write cost per 1M tokens (1-hour TTL, Anthropic). */
  cacheWrite1hCostPer1M?: number;
}

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  models: CatalogModel[];
  defaultModel: string;
  apiKeyUrl?: string;
  apiKeyPlaceholder?: string;
}

// ── Anthropic capability helpers ─────────────────────────────────────
// Anthropic's published pricing relationships (as of 2026-04-17):
//   cache read   = input * 0.1
//   cache write  = input * 1.25 (5-minute TTL) or * 2 (1-hour TTL)
// Keep these as helpers so updates to the ratios (if Anthropic changes
// them) happen in one place.
const ANTHROPIC_CACHE_READ_RATIO = 0.1;
const ANTHROPIC_CACHE_WRITE_5M_RATIO = 1.25;
const ANTHROPIC_CACHE_WRITE_1H_RATIO = 2;

function anthropicCacheRates(
  inputCostPer1M: number,
): Pick<
  CatalogModel,
  "cacheReadCostPer1M" | "cacheWrite5mCostPer1M" | "cacheWrite1hCostPer1M"
> {
  return {
    cacheReadCostPer1M: inputCostPer1M * ANTHROPIC_CACHE_READ_RATIO,
    cacheWrite5mCostPer1M: inputCostPer1M * ANTHROPIC_CACHE_WRITE_5M_RATIO,
    cacheWrite1hCostPer1M: inputCostPer1M * ANTHROPIC_CACHE_WRITE_1H_RATIO,
  };
}

/** Single source of truth for all inference provider metadata and models. */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    models: [
      {
        id: "claude-opus-4-7",
        displayName: "Claude Opus 4.7",
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        supportsPromptCaching: true,
        inputCostPer1M: 5,
        outputCostPer1M: 25,
        ...anthropicCacheRates(5),
      },
      {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        supportsPromptCaching: true,
        inputCostPer1M: 5,
        outputCostPer1M: 25,
        ...anthropicCacheRates(5),
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsPromptCaching: true,
        inputCostPer1M: 3,
        outputCostPer1M: 15,
        ...anthropicCacheRates(3),
      },
      {
        id: "claude-haiku-4-5-20251001",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsPromptCaching: true,
        inputCostPer1M: 1,
        outputCostPer1M: 5,
        ...anthropicCacheRates(1),
      },
    ],
    defaultModel: "claude-opus-4-6",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "sk-ant-api03-...",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    models: [
      {
        // GPT-5.4: reasoning-capable flagship. OpenAI supports implicit
        // prompt caching on the responses API since GPT-4o.
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        // TODO: verify — estimated from GPT-5 family norms (400k input window).
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsPromptCaching: true,
      },
      {
        id: "gpt-5.2",
        displayName: "GPT-5.2",
        // TODO: verify — estimated from GPT-5 family norms.
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsPromptCaching: true,
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        // TODO: verify — estimated from GPT-5 family norms.
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsPromptCaching: true,
      },
      {
        id: "gpt-5.4-nano",
        displayName: "GPT-5.4 Nano",
        // TODO: verify — estimated from GPT-5 family norms.
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsPromptCaching: true,
      },
    ],
    defaultModel: "gpt-5.4",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-proj-...",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    models: [
      {
        // Gemini 3 Flash — assume 1M input window per published Gemini 2.x/3.x
        // family; verify against docs when Google publishes 3.x specifics.
        id: "gemini-3-flash",
        displayName: "Gemini 3 Flash",
        // TODO: verify — extrapolated from Gemini 2.5 family (1M window).
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsPromptCaching: true,
      },
      {
        id: "gemini-3-pro",
        displayName: "Gemini 3 Pro",
        // TODO: verify — extrapolated from Gemini 2.5 family (1M window).
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsPromptCaching: true,
      },
    ],
    defaultModel: "gemini-3-flash",
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
        contextWindow: 131_072,
        maxOutputTokens: 65_536,
        // Self-hosted; no provider-side prompt-cache sharing.
        supportsPromptCaching: false,
      },
      {
        id: "mistral",
        displayName: "Mistral",
        contextWindow: 32_768,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
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
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        // TODO: verify — Fireworks prompt-caching support per model varies.
        supportsPromptCaching: false,
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
      // Anthropic — mirror direct Anthropic entries; caching supported via
      // OpenRouter's Anthropic passthrough.
      {
        id: "anthropic/claude-opus-4.7",
        displayName: "Claude Opus 4.7",
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        supportsPromptCaching: true,
      },
      {
        id: "anthropic/claude-opus-4.6",
        displayName: "Claude Opus 4.6",
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        supportsPromptCaching: true,
      },
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsPromptCaching: true,
      },
      {
        id: "anthropic/claude-haiku-4.5",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsPromptCaching: true,
      },
      // xAI
      {
        id: "x-ai/grok-4.20-beta",
        displayName: "Grok 4.20 Beta",
        // TODO: verify — xAI Grok 4 family (256k window per xAI docs).
        contextWindow: 256_000,
        maxOutputTokens: 32_768,
        supportsPromptCaching: false,
      },
      {
        id: "x-ai/grok-4",
        displayName: "Grok 4",
        // TODO: verify — xAI Grok 4 family.
        contextWindow: 256_000,
        maxOutputTokens: 32_768,
        supportsPromptCaching: false,
      },
      // DeepSeek
      {
        id: "deepseek/deepseek-r1-0528",
        displayName: "DeepSeek R1",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 32_768,
        supportsPromptCaching: false,
      },
      {
        id: "deepseek/deepseek-chat-v3-0324",
        displayName: "DeepSeek V3",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      // Qwen
      {
        id: "qwen/qwen3.5-plus-02-15",
        displayName: "Qwen 3.5 Plus",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      {
        id: "qwen/qwen3.5-397b-a17b",
        displayName: "Qwen 3.5 397B",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      {
        id: "qwen/qwen3.5-flash-02-23",
        displayName: "Qwen 3.5 Flash",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      {
        id: "qwen/qwen3-coder-next",
        displayName: "Qwen 3 Coder",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      // Moonshot
      {
        id: "moonshotai/kimi-k2.5",
        displayName: "Kimi K2.5",
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        // TODO: verify.
        supportsPromptCaching: false,
      },
      // Mistral
      {
        id: "mistralai/mistral-medium-3",
        displayName: "Mistral Medium 3",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      {
        id: "mistralai/mistral-small-2603",
        displayName: "Mistral Small 4",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      {
        id: "mistralai/devstral-2512",
        displayName: "Devstral 2",
        // TODO: verify.
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      // Meta
      {
        id: "meta-llama/llama-4-maverick",
        displayName: "Llama 4 Maverick",
        // TODO: verify — Llama 4 family (~1M window per Meta docs).
        contextWindow: 1_048_576,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      {
        id: "meta-llama/llama-4-scout",
        displayName: "Llama 4 Scout",
        // TODO: verify — Llama 4 family.
        contextWindow: 1_048_576,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
      },
      // Amazon
      {
        id: "amazon/nova-pro-v1",
        displayName: "Amazon Nova Pro",
        // TODO: verify — Nova Pro v1 (~300k window per AWS docs).
        contextWindow: 300_000,
        maxOutputTokens: 16_384,
        supportsPromptCaching: false,
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

/**
 * Look up full capability + pricing metadata for a given provider/model pair.
 *
 * Provider name match is case-insensitive so callers don't have to know the
 * canonical casing (e.g. `"Anthropic"` and `"anthropic"` both resolve). Model
 * ID match is exact — vendor model IDs are already canonical.
 *
 * Returns `null` when the provider or model is not in the catalog. Callers
 * should fall back to a conservative default (e.g. a 200k context window) so
 * an unseen model never blocks budgeting logic.
 */
export function getModelCapabilities(
  providerName: string,
  modelId: string,
): CatalogModel | null {
  const normalized = providerName.toLowerCase();
  const entry = PROVIDER_CATALOG.find((p) => p.id.toLowerCase() === normalized);
  if (!entry) return null;
  return entry.models.find((m) => m.id === modelId) ?? null;
}
