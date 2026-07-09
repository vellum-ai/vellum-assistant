import { PLATFORM_PROVIDER_META } from "./platform-proxy/constants.js";

export type LongContextMode =
  | "native-model"
  | "provider-request-option"
  | "unsupported";

export interface CatalogModelPricingTier {
  /**
   * Threshold in total prompt input tokens above which this tier's rates
   * apply. The largest matched threshold wins when usage exceeds multiple
   * tiers (single-step staircase, not progressive bracketing).
   */
  inputTokenThreshold: number;
  inputPer1mTokens: number;
  outputPer1mTokens: number;
  cacheReadPer1mTokens?: number;
  cacheWritePer1mTokens?: number;
}

export interface CatalogModelPricing {
  inputPer1mTokens: number;
  outputPer1mTokens: number;
  cacheWritePer1mTokens?: number;
  cacheReadPer1mTokens?: number;
  /**
   * Optional long-context pricing tiers. Selected by total prompt input
   * tokens. When set, the base fields above apply at the low-context tier
   * (below every tier threshold) and tier entries override at higher
   * thresholds.
   */
  tiers?: CatalogModelPricingTier[];
}

export interface CatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  defaultContextWindowTokens?: number;
  longContextPricingThresholdTokens?: number;
  longContextMode?: LongContextMode;
  supportsThinking?: boolean;
  /**
   * When true, the model always reasons with adaptive (always-on) thinking and
   * rejects an explicit `thinking: { type: "disabled" }` request (Anthropic
   * 400s such calls). Clients hide the enable/disable thinking toggle for these
   * models — effort stays adjustable — and the daemon drops a disabled thinking
   * config (and any non-1 `temperature`, which adaptive mode also rejects)
   * before dispatching. Implies `supportsThinking`.
   */
  adaptiveThinkingOnly?: boolean;
  supportsCaching?: boolean;
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  pricing?: CatalogModelPricing;
  /**
   * Upper bound for `reasoning_effort` accepted by this model's upstream API.
   * Used by providers (e.g. Fireworks) to clamp Vellum's `xhigh`/`max` tiers
   * down to whatever the model documents. Omit to inherit the provider
   * default.
   */
  maxEffort?: "high" | "xhigh" | "max";
  /** When set, this model is only visible when the named feature flag is enabled. */
  featureFlag?: string;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS = 272000;

function catalogModel(model: CatalogModel): CatalogModel {
  const configuredDefaultContextWindowTokens =
    model.defaultContextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const defaultContextWindowTokens =
    model.contextWindowTokens === undefined
      ? configuredDefaultContextWindowTokens
      : Math.min(
          configuredDefaultContextWindowTokens,
          model.contextWindowTokens,
        );

  return {
    ...model,
    defaultContextWindowTokens,
    longContextMode:
      model.longContextMode ??
      ((model.contextWindowTokens ?? 0) > DEFAULT_CONTEXT_WINDOW_TOKENS
        ? "native-model"
        : "unsupported"),
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
  /**
   * Whether this provider supports the `platform` auth type (Vellum-managed
   * keys routed through the platform proxy). Derived from
   * `PLATFORM_PROVIDER_META` at catalog build time so the two stay in lock
   * step. Clients use this field to hide the "Platform (managed by Vellum)"
   * option from the auth-type dropdown for providers like Fireworks or
   * OpenRouter where managed keys are not available.
   */
  supportsPlatformAuth?: boolean;
  /** When set, this provider is only visible when the named feature flag is enabled. */
  featureFlag?: string;
}

/**
 * Canonical assistant catalog for inference provider metadata and models.
 * `meta/llm-provider-catalog.json` mirrors the client-facing subset and is
 * kept in parity by `llm-catalog-parity.test.ts`; native-client fallbacks
 * mirror only the startup-critical display/setup/context metadata.
 *
 * Model limits verified 2026-04-30 against official provider docs:
 * - Anthropic model overview and context window docs:
 *   https://platform.claude.com/docs/en/about-claude/models/overview
 *   https://platform.claude.com/docs/en/build-with-claude/context-windows
 * - OpenAI model comparison and model detail docs:
 *   https://developers.openai.com/api/docs/models/compare
 *   https://developers.openai.com/api/docs/models
 * - Google Gemini model docs:
 *   https://ai.google.dev/gemini-api/docs/models
 *
 * contextWindowTokens is the maximum known input context. maxOutputTokens is
 * the maximum standard synchronous Messages/Responses output limit.
 */
const RAW_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
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
        id: "claude-fable-5",
        displayName: "Claude Fable 5",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        adaptiveThinkingOnly: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 10,
          outputPer1mTokens: 50,
          cacheWritePer1mTokens: 12.5,
          cacheReadPer1mTokens: 1,
        },
      },
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        id: "claude-opus-4-7",
        displayName: "Claude Opus 4.7",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        // Introductory pricing in effect through 2026-08-31 ($2/$10 vs the
        // $3/$15 standard rate). Bump to standard once the intro window ends.
        pricing: {
          inputPer1mTokens: 2,
          outputPer1mTokens: 10,
          cacheWritePer1mTokens: 2.5,
          cacheReadPer1mTokens: 0.2,
        },
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 1000000,
        maxOutputTokens: 64000,
        longContextPricingThresholdTokens: 200000,
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
        id: "claude-sonnet-4-5-20250929",
        displayName: "Claude Sonnet 4.5",
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
        id: "claude-opus-4-5-20251101",
        displayName: "Claude Opus 4.5",
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
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
        id: "claude-haiku-4-5-20251001",
        displayName: "Claude Haiku 4.5",
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
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
    defaultModel: "claude-opus-4-8",
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
      // GPT-5.6 family (Sol / Terra / Luna). cacheRead is the 90% cached-read
      // discount; long-context (>272K input) is 2x input / 1.5x output / 2x
      // cache-read for the whole request, per OpenAI's model cards. GPT-5.6+
      // also bills cache *writes* at 1.25x input, but that isn't represented
      // here — the managed proxy's OpenAI billing path emits no cache-write
      // token class (Anthropic-only today).
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 5.0,
          outputPer1mTokens: 30.0,
          cacheReadPer1mTokens: 0.5,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 10,
              outputPer1mTokens: 45,
              cacheReadPer1mTokens: 1,
            },
          ],
        },
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 2.5,
          outputPer1mTokens: 15.0,
          cacheReadPer1mTokens: 0.25,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 5,
              outputPer1mTokens: 22.5,
              cacheReadPer1mTokens: 0.5,
            },
          ],
        },
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1.0,
          outputPer1mTokens: 6.0,
          cacheReadPer1mTokens: 0.1,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 2,
              outputPer1mTokens: 9,
              cacheReadPer1mTokens: 0.2,
            },
          ],
        },
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 5.0,
          outputPer1mTokens: 30.0,
          cacheReadPer1mTokens: 0.5,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 10,
              outputPer1mTokens: 45,
              cacheReadPer1mTokens: 1,
            },
          ],
        },
      },
      {
        id: "gpt-5.5-pro",
        displayName: "GPT-5.5 Pro",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 30.0,
          outputPer1mTokens: 180.0,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 60,
              outputPer1mTokens: 270,
            },
          ],
        },
      },
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 2.5,
          outputPer1mTokens: 15.0,
          cacheReadPer1mTokens: 0.25,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 5,
              outputPer1mTokens: 22.5,
              cacheReadPer1mTokens: 0.5,
            },
          ],
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
          inputPer1mTokens: 0.75,
          outputPer1mTokens: 4.5,
          cacheReadPer1mTokens: 0.075,
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
    defaultModel: "gpt-5.5",
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
        id: "gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1.5,
          outputPer1mTokens: 9.0,
          cacheReadPer1mTokens: 0.15,
        },
      },
      {
        id: "gemini-3.1-pro-preview",
        displayName: "Gemini 3.1 Pro Preview",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 2.0,
          outputPer1mTokens: 12.0,
          cacheReadPer1mTokens: 0.2,
          tiers: [
            {
              inputTokenThreshold: 200_000,
              inputPer1mTokens: 4,
              outputPer1mTokens: 18,
              cacheReadPer1mTokens: 0.4,
            },
          ],
        },
      },
      {
        id: "gemini-3.1-pro-preview-customtools",
        displayName: "Gemini 3.1 Pro Preview (Custom Tools)",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 2.0,
          outputPer1mTokens: 12.0,
          cacheReadPer1mTokens: 0.2,
          tiers: [
            {
              inputTokenThreshold: 200_000,
              inputPer1mTokens: 4,
              outputPer1mTokens: 18,
              cacheReadPer1mTokens: 0.4,
            },
          ],
        },
      },
      {
        id: "gemini-3-flash-preview",
        displayName: "Gemini 3 Flash Preview",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
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
        id: "gemini-3.1-flash-lite-preview",
        displayName: "Gemini 3.1 Flash-Lite Preview",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.25,
          outputPer1mTokens: 1.5,
          cacheReadPer1mTokens: 0.025,
        },
      },
      {
        id: "gemini-3.1-flash-lite",
        displayName: "Gemini 3.1 Flash-Lite",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 0.25,
          outputPer1mTokens: 1.5,
          cacheReadPer1mTokens: 0.025,
        },
      },
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
          cacheReadPer1mTokens: 0.03,
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
          cacheReadPer1mTokens: 0.01,
        },
      },
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1.25,
          outputPer1mTokens: 10.0,
          cacheReadPer1mTokens: 0.3125,
          tiers: [
            {
              inputTokenThreshold: 200_000,
              inputPer1mTokens: 2.5,
              outputPer1mTokens: 15,
              cacheReadPer1mTokens: 0.625,
            },
          ],
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
        id: "accounts/fireworks/models/kimi-k2p6",
        displayName: "Kimi K2.6",
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        maxEffort: "high",
        pricing: {
          inputPer1mTokens: 0.95,
          outputPer1mTokens: 4.0,
          cacheReadPer1mTokens: 0.16,
        },
      },
      {
        id: "accounts/fireworks/models/glm-5p2",
        displayName: "GLM 5.2",
        // Fireworks serves GLM 5.2 with a 1,040K input window.
        contextWindowTokens: 1040000,
        maxOutputTokens: 131072,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: false,
        supportsToolUse: true,
        maxEffort: "max",
        pricing: {
          inputPer1mTokens: 1.4,
          outputPer1mTokens: 4.4,
          cacheReadPer1mTokens: 0.26,
        },
      },
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
      {
        id: "accounts/fireworks/models/minimax-m3",
        displayName: "MiniMax M3",
        // The model supports 1M context, but Fireworks serves it with a
        // 512K (524,288-token) window; advertise the served limit.
        contextWindowTokens: 524288,
        maxOutputTokens: 512000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        maxEffort: "high",
        pricing: {
          inputPer1mTokens: 0.3,
          outputPer1mTokens: 1.2,
          cacheReadPer1mTokens: 0.06,
        },
      },
      {
        id: "accounts/fireworks/models/minimax-m2p7",
        displayName: "MiniMax M2.7",
        contextWindowTokens: 196608,
        maxOutputTokens: 25000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.3, outputPer1mTokens: 1.2 },
      },
      {
        id: "accounts/fireworks/models/minimax-m2p5",
        displayName: "MiniMax M2.5",
        contextWindowTokens: 196608,
        maxOutputTokens: 25000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.3, outputPer1mTokens: 1.2 },
      },
      {
        id: "accounts/fireworks/models/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindowTokens: 1040000,
        maxOutputTokens: 131072,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        maxEffort: "max",
        pricing: { inputPer1mTokens: 1.74, outputPer1mTokens: 3.48 },
      },
      {
        id: "accounts/fireworks/models/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindowTokens: 1040000,
        maxOutputTokens: 131072,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: false,
        supportsToolUse: true,
        maxEffort: "max",
        pricing: {
          inputPer1mTokens: 0.14,
          outputPer1mTokens: 0.28,
          cacheReadPer1mTokens: 0.03,
        },
      },
    ],
    defaultModel: "accounts/fireworks/models/kimi-k2p5",
    apiKeyUrl: "https://fireworks.ai/account/api-keys",
    apiKeyPlaceholder: "fw_...",
  },
  {
    id: "together",
    displayName: "Together AI",
    subtitle: "Open models served by Together AI. Requires a Together API key.",
    setupMode: "api-key",
    setupHint: "Enter your Together API key to enable Together models.",
    envVar: "TOGETHER_API_KEY",
    credentialsGuide: {
      description: "Sign in to the Together dashboard and create an API key.",
      url: "https://api.together.ai/settings/api-keys",
      linkLabel: "Open Together Dashboard",
    },
    models: [
      {
        id: "MiniMaxAI/MiniMax-M3",
        displayName: "MiniMax M3",
        // Managed route for MiniMax M3. Together honors forced tool_choice
        // and serializes object-typed tool args correctly. Window and pricing
        // are from Together's published rate card.
        contextWindowTokens: 524288,
        maxOutputTokens: 512000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        maxEffort: "high",
        pricing: {
          inputPer1mTokens: 0.3,
          outputPer1mTokens: 1.2,
          cacheReadPer1mTokens: 0.06,
        },
      },
    ],
    defaultModel: "MiniMaxAI/MiniMax-M3",
    apiKeyUrl: "https://api.together.ai/settings/api-keys",
    apiKeyPlaceholder: "...",
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
        id: "anthropic/claude-fable-5",
        displayName: "Claude Fable 5",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        adaptiveThinkingOnly: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 10,
          outputPer1mTokens: 50,
          cacheWritePer1mTokens: 12.5,
          cacheReadPer1mTokens: 1,
        },
      },
      {
        id: "anthropic/claude-opus-4.8",
        displayName: "Claude Opus 4.8",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        id: "anthropic/claude-opus-4.7",
        displayName: "Claude Opus 4.7",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        id: "anthropic/claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        // Introductory pricing in effect through 2026-08-31 ($2/$10 vs the
        // $3/$15 standard rate). Bump to standard once the intro window ends.
        pricing: {
          inputPer1mTokens: 2,
          outputPer1mTokens: 10,
          cacheWritePer1mTokens: 2.5,
          cacheReadPer1mTokens: 0.2,
        },
      },
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 1000000,
        maxOutputTokens: 64000,
        longContextPricingThresholdTokens: 200000,
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
        id: "anthropic/claude-sonnet-4.5",
        displayName: "Claude Sonnet 4.5",
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
        id: "anthropic/claude-opus-4.5",
        displayName: "Claude Opus 4.5",
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
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
        id: "anthropic/claude-haiku-4.5",
        displayName: "Claude Haiku 4.5",
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
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
      // OpenRouter lists an `input_cache_read` rate for xAI models but its
      // xAI endpoints report `supports_implicit_caching: false`, and observed
      // usage never includes cached tokens. `supportsCaching` therefore stays
      // false; the `cacheReadPer1mTokens` rates below only apply if OpenRouter
      // starts reporting cached tokens in usage.
      {
        id: "x-ai/grok-4.5",
        displayName: "Grok 4.5",
        contextWindowTokens: 500000,
        // xAI publishes no completion cap; 30K is the tracker-reported
        // single-response limit.
        maxOutputTokens: 30000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 2,
          outputPer1mTokens: 6,
          cacheReadPer1mTokens: 0.5,
        },
      },
      {
        id: "x-ai/grok-4.3",
        displayName: "Grok 4.3",
        contextWindowTokens: 1000000,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1.25,
          outputPer1mTokens: 2.5,
          cacheReadPer1mTokens: 0.2,
        },
      },
      {
        id: "x-ai/grok-4.20",
        displayName: "Grok 4.20",
        contextWindowTokens: 2000000,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 1.25,
          outputPer1mTokens: 2.5,
          cacheReadPer1mTokens: 0.2,
        },
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
      {
        id: "deepseek/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindowTokens: 1048576,
        maxOutputTokens: 384000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.435, outputPer1mTokens: 0.87 },
      },
      {
        id: "deepseek/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindowTokens: 1048576,
        maxOutputTokens: 384000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.14, outputPer1mTokens: 0.28 },
      },
      {
        id: "deepseek/deepseek-v3.2-speciale",
        displayName: "DeepSeek V3.2 Speciale",
        contextWindowTokens: 163840,
        maxOutputTokens: 163840,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: false,
        pricing: { inputPer1mTokens: 0.287, outputPer1mTokens: 0.431 },
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
      // MiniMax
      {
        id: "minimax/minimax-m3",
        displayName: "MiniMax M3",
        // The model supports 1M context, but OpenRouter's only route
        // (MiniMax) accepts 524,288 tokens; advertise the routed limit.
        contextWindowTokens: 524288,
        maxOutputTokens: 512000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.3, outputPer1mTokens: 1.2 },
      },
      {
        id: "minimax/minimax-m2.7",
        displayName: "MiniMax M2.7",
        contextWindowTokens: 196608,
        maxOutputTokens: 131072,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.279, outputPer1mTokens: 1.2 },
      },
      {
        id: "minimax/minimax-m2.5",
        displayName: "MiniMax M2.5",
        contextWindowTokens: 196608,
        maxOutputTokens: 196608,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.15, outputPer1mTokens: 1.15 },
      },
      {
        id: "minimax/minimax-m2.1",
        displayName: "MiniMax M2.1",
        contextWindowTokens: 196608,
        maxOutputTokens: 196608,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.29, outputPer1mTokens: 0.95 },
      },
      {
        id: "minimax/minimax-m2",
        displayName: "MiniMax M2",
        contextWindowTokens: 196608,
        maxOutputTokens: 196608,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.255, outputPer1mTokens: 1.0 },
      },
      {
        id: "minimax/minimax-m2-her",
        displayName: "MiniMax M2-her",
        contextWindowTokens: 65536,
        maxOutputTokens: 2048,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: false,
        pricing: { inputPer1mTokens: 0.3, outputPer1mTokens: 1.2 },
      },
      {
        id: "minimax/minimax-m1",
        displayName: "MiniMax M1",
        contextWindowTokens: 1000000,
        maxOutputTokens: 40000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.4, outputPer1mTokens: 2.2 },
      },
      {
        id: "minimax/minimax-01",
        displayName: "MiniMax-01",
        contextWindowTokens: 1000000,
        maxOutputTokens: 1000000,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: false,
        pricing: { inputPer1mTokens: 0.2, outputPer1mTokens: 1.1 },
      },
      // Z.ai
      {
        id: "z-ai/glm-5.2",
        displayName: "GLM-5.2",
        contextWindowTokens: 1048576,
        maxOutputTokens: 131072,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 1.4, outputPer1mTokens: 4.4 },
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
      // Owl (OpenRouter first-party)
      {
        id: "openrouter/owl-alpha",
        displayName: "Owl Alpha",
        contextWindowTokens: 1048576,
        maxOutputTokens: 262144,
        supportsThinking: false,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0 },
      },
    ],
    defaultModel: "x-ai/grok-4.20",
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyPlaceholder: "sk-or-v1-...",
  },
  {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    subtitle:
      "Route to many LLM providers via a single Vercel AI Gateway API key.",
    setupMode: "api-key",
    setupHint:
      "Enter your Vercel AI Gateway API key to access multiple models.",
    envVar: "AI_GATEWAY_API_KEY",
    credentialsGuide: {
      description:
        "Open the Vercel dashboard's AI Gateway tab and create an API key.",
      url: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys",
      linkLabel: "Open Vercel Dashboard",
    },
    // Model IDs verified 2026-07-07 against Vercel's model directory:
    // https://vercel.com/ai-gateway/models
    models: [
      // Anthropic
      // The gateway proxies anthropic/* through Anthropic's Messages API, so
      // prompt caching and cache TTL metadata pass through unchanged and
      // billing matches Anthropic's direct rates.
      {
        id: "anthropic/claude-fable-5",
        displayName: "Claude Fable 5",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        adaptiveThinkingOnly: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 10,
          outputPer1mTokens: 50,
          cacheWritePer1mTokens: 12.5,
          cacheReadPer1mTokens: 1,
        },
      },
      {
        id: "anthropic/claude-opus-4.8",
        displayName: "Claude Opus 4.8",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
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
        id: "anthropic/claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens: 200000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        // Introductory pricing in effect through 2026-08-31 ($2/$10 vs the
        // $3/$15 standard rate). Bump to standard once the intro window ends.
        pricing: {
          inputPer1mTokens: 2,
          outputPer1mTokens: 10,
          cacheWritePer1mTokens: 2.5,
          cacheReadPer1mTokens: 0.2,
        },
      },
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 1000000,
        maxOutputTokens: 64000,
        longContextPricingThresholdTokens: 200000,
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
        maxOutputTokens: 64000,
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
      // OpenAI
      {
        id: "openai/gpt-5.5",
        displayName: "GPT-5.5",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 5.0,
          outputPer1mTokens: 30.0,
          cacheReadPer1mTokens: 0.5,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 10,
              outputPer1mTokens: 45,
              cacheReadPer1mTokens: 1,
            },
          ],
        },
      },
      {
        id: "openai/gpt-5.5-pro",
        displayName: "GPT-5.5 Pro",
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        longContextPricingThresholdTokens:
          OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
        pricing: {
          inputPer1mTokens: 30.0,
          outputPer1mTokens: 180.0,
          tiers: [
            {
              inputTokenThreshold: OPENAI_LONG_CONTEXT_PRICING_THRESHOLD_TOKENS,
              inputPer1mTokens: 60,
              outputPer1mTokens: 270,
            },
          ],
        },
      },
      // xAI (Vercel's vendor prefix is `xai/`, not OpenRouter's `x-ai/`)
      {
        id: "xai/grok-4.3",
        displayName: "Grok 4.3",
        contextWindowTokens: 1000000,
        maxOutputTokens: 16000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: true,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 1.25, outputPer1mTokens: 2.5 },
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
        // Gateway list rate (blended across routed upstreams).
        pricing: { inputPer1mTokens: 0.95, outputPer1mTokens: 4.0 },
      },
      // DeepSeek
      {
        id: "deepseek/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindowTokens: 1048576,
        maxOutputTokens: 384000,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
        pricing: { inputPer1mTokens: 0.14, outputPer1mTokens: 0.28 },
      },
    ],
    defaultModel: "anthropic/claude-sonnet-4.6",
    apiKeyUrl:
      "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys",
    apiKeyPlaceholder: "vck_...",
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible",
    subtitle:
      "Bring your own OpenAI-compatible endpoint (vLLM, LMStudio, Groq, Together, etc.).",
    setupMode: "api-key",
    setupHint:
      "Enter the base URL of your endpoint and at least one model identifier.",
    apiKeyPlaceholder: "Your provider's API key",
    models: [],
    defaultModel: "",
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    subtitle: "MiniMax AI models. Requires a MiniMax API key.",
    setupMode: "api-key",
    setupHint: "Enter your MiniMax API key to enable MiniMax models.",
    envVar: "MINIMAX_API_KEY",
    credentialsGuide: {
      description: "Sign in to the MiniMax dashboard and create an API key.",
      url: "https://platform.minimax.io/",
      linkLabel: "Open MiniMax Dashboard",
    },
    models: [
      {
        id: "MiniMax-M3",
        displayName: "MiniMax M3",
        contextWindowTokens: 1000000,
        maxOutputTokens: 512000,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: true,
        supportsToolUse: true,
      },
      {
        id: "MiniMax-M2.7",
        displayName: "MiniMax M2.7",
        contextWindowTokens: 200000,
        maxOutputTokens: 16384,
        supportsThinking: true,
        supportsCaching: true,
        supportsVision: false,
        supportsToolUse: true,
      },
    ],
    defaultModel: "MiniMax-M2.7",
    apiKeyUrl: "https://platform.minimax.io/",
    apiKeyPlaceholder: "sk-cp-...",
  },
  {
    id: "atlascloud",
    displayName: "Atlas Cloud",
    subtitle:
      "Atlas Cloud AI models (OpenAI-compatible). Requires an Atlas Cloud API key.",
    setupMode: "api-key",
    setupHint: "Enter your Atlas Cloud API key to enable Atlas Cloud models.",
    envVar: "ATLASCLOUD_API_KEY",
    credentialsGuide: {
      description: "Sign in to the Atlas Cloud console and create an API key.",
      url: "https://www.atlascloud.ai/console",
      linkLabel: "Open Atlas Cloud Console",
    },
    models: [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
        supportsThinking: true,
        supportsCaching: false,
        supportsVision: false,
        supportsToolUse: true,
      },
    ],
    defaultModel: "deepseek-ai/deepseek-v4-pro",
    apiKeyUrl: "https://www.atlascloud.ai/console",
    apiKeyPlaceholder: "apikey-...",
  },
];

export const PROVIDER_CATALOG: ProviderCatalogEntry[] =
  RAW_PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    models: entry.models.map(catalogModel),
    // Derive supportsPlatformAuth from PLATFORM_PROVIDER_META so the catalog
    // and the proxy routing table can never drift. Adding a provider to
    // PLATFORM_PROVIDER_META with `managed: true` automatically opts it into
    // the Platform auth-type dropdown in the clients.
    supportsPlatformAuth: PLATFORM_PROVIDER_META[entry.id]?.managed === true,
  }));

/** Check if a model ID is in the catalog for a given provider. */
export function isModelInCatalog(provider: string, modelId: string): boolean {
  const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
  return entry?.models.some((m) => m.id === modelId) ?? false;
}

/**
 * Return the catalog provider that owns a model ID, if known. When multiple
 * providers list the same ID (e.g. OpenRouter and the Vercel AI Gateway share
 * `anthropic/*` IDs), the earliest entry in PROVIDER_CATALOG order wins.
 */
export function getCatalogProviderForModel(
  modelId: string,
): string | undefined {
  return PROVIDER_CATALOG.find((p) => p.models.some((m) => m.id === modelId))
    ?.id;
}

/**
 * Whether the given model only supports adaptive (always-on) thinking, driven
 * by the `adaptiveThinkingOnly` capability in the catalog. Matches the model ID
 * across every provider (a model carries the same id under each provider it is
 * offered by, e.g. `claude-fable-5` and OpenRouter's `anthropic/claude-fable-5`).
 */
export function isAdaptiveThinkingOnlyModel(modelId: string): boolean {
  return PROVIDER_CATALOG.some((p) =>
    p.models.some((m) => m.id === modelId && m.adaptiveThinkingOnly === true),
  );
}
