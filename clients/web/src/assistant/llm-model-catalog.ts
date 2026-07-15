// Hand-maintained mirror of the LLM provider/model catalog for the web app.
//
// Source of truth: assistant/src/providers/model-catalog.ts, which
// generates meta/llm-provider-catalog.json via
//   cd assistant && bun run sync:llm-catalog
// This file mirrors the subset the web UI needs (no pricing/vision/caching
// fields).
//
// Parity is enforced by llm-model-catalog.test.ts: update the daemon
// catalog first, run the sync, then mirror the change here.

export interface LlmCatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens: number;
  defaultContextWindowTokens: number;
  maxOutputTokens: number;
  supportsThinking?: boolean;
  adaptiveThinkingOnly?: boolean;
  longContextPricingThresholdTokens?: number;
}

export const MODELS_BY_PROVIDER = {
  anthropic: [
    {
      id: "claude-fable-5",
      displayName: "Claude Fable 5",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      adaptiveThinkingOnly: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "claude-sonnet-4-5-20250929",
      displayName: "Claude Sonnet 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
    {
      id: "claude-opus-4-5-20251101",
      displayName: "Claude Opus 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
    {
      id: "claude-haiku-4-5-20251001",
      displayName: "Claude Haiku 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
  ],
  openai: [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "gpt-5.5-pro",
      displayName: "GPT-5.5 Pro",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "gpt-5.2",
      displayName: "GPT-5.2",
      contextWindowTokens: 400_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
    },
    {
      id: "gpt-5.4-mini",
      displayName: "GPT-5.4 Mini",
      contextWindowTokens: 400_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
    },
    {
      id: "gpt-5.4-nano",
      displayName: "GPT-5.4 Nano",
      contextWindowTokens: 400_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
    },
  ],
  gemini: [
    {
      id: "gemini-3.5-flash",
      displayName: "Gemini 3.5 Flash",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
    },
    {
      id: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro Preview",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "gemini-3.1-pro-preview-customtools",
      displayName: "Gemini 3.1 Pro Preview (Custom Tools)",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "gemini-3-flash-preview",
      displayName: "Gemini 3 Flash Preview",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
    },
    {
      id: "gemini-3.1-flash-lite-preview",
      displayName: "Gemini 3.1 Flash-Lite Preview",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
    },
    {
      id: "gemini-3.1-flash-lite",
      displayName: "Gemini 3.1 Flash-Lite",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
    },
    {
      id: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
    },
    {
      id: "gemini-2.5-flash-lite",
      displayName: "Gemini 2.5 Flash Lite",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
    },
    {
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 65_536,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
  ],
  ollama: [
    {
      id: "llama3.2",
      displayName: "Llama 3.2",
      contextWindowTokens: 128_000,
      defaultContextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
    },
    {
      id: "mistral",
      displayName: "Mistral",
      contextWindowTokens: 32_768,
      defaultContextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
    },
  ],
  fireworks: [
    {
      id: "accounts/fireworks/models/kimi-k2p6",
      displayName: "Kimi K2.6",
      contextWindowTokens: 262_144,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 32_768,
      supportsThinking: true,
    },
    {
      id: "accounts/fireworks/models/glm-5p2",
      displayName: "GLM 5.2",
      contextWindowTokens: 1_040_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
    },
    {
      id: "accounts/fireworks/models/kimi-k2p5",
      displayName: "Kimi K2.5",
      contextWindowTokens: 256_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 32_768,
    },
    {
      id: "accounts/fireworks/models/minimax-m3",
      displayName: "MiniMax M3",
      contextWindowTokens: 524_288,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 512_000,
      supportsThinking: true,
    },
    {
      id: "accounts/fireworks/models/minimax-m2p7",
      displayName: "MiniMax M2.7",
      contextWindowTokens: 196_608,
      defaultContextWindowTokens: 196_608,
      maxOutputTokens: 25_000,
    },
    {
      id: "accounts/fireworks/models/minimax-m2p5",
      displayName: "MiniMax M2.5",
      contextWindowTokens: 196_608,
      defaultContextWindowTokens: 196_608,
      maxOutputTokens: 25_000,
    },
    {
      id: "accounts/fireworks/models/deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindowTokens: 1_040_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
    },
    {
      id: "accounts/fireworks/models/deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindowTokens: 1_040_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
    },
  ],
  together: [
    {
      id: "MiniMaxAI/MiniMax-M3",
      displayName: "MiniMax M3",
      contextWindowTokens: 524_288,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 512_000,
      supportsThinking: true,
    },
  ],
  openrouter: [
    {
      id: "anthropic/claude-fable-5",
      displayName: "Claude Fable 5",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      adaptiveThinkingOnly: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-opus-4.8",
      displayName: "Claude Opus 4.8",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-opus-4.7",
      displayName: "Claude Opus 4.7",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-opus-4.6",
      displayName: "Claude Opus 4.6",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-sonnet-4.6",
      displayName: "Claude Sonnet 4.6",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-sonnet-4.5",
      displayName: "Claude Sonnet 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
    {
      id: "anthropic/claude-opus-4.5",
      displayName: "Claude Opus 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
    {
      id: "anthropic/claude-haiku-4.5",
      displayName: "Claude Haiku 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
    {
      id: "openai/gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "openai/gpt-5.6-sol-pro",
      displayName: "GPT-5.6 Sol Pro",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "openai/gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "openai/gpt-5.6-terra-pro",
      displayName: "GPT-5.6 Terra Pro",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "openai/gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "openai/gpt-5.6-luna-pro",
      displayName: "GPT-5.6 Luna Pro",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "x-ai/grok-4.5",
      displayName: "Grok 4.5",
      contextWindowTokens: 500_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 30_000,
      supportsThinking: true,
    },
    {
      id: "x-ai/grok-4.3",
      displayName: "Grok 4.3",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
      supportsThinking: true,
    },
    {
      id: "x-ai/grok-4.20",
      displayName: "Grok 4.20",
      contextWindowTokens: 2_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
      supportsThinking: true,
    },
    {
      id: "deepseek/deepseek-r1-0528",
      displayName: "DeepSeek R1",
      contextWindowTokens: 163_840,
      defaultContextWindowTokens: 163_840,
      maxOutputTokens: 32_000,
      supportsThinking: true,
    },
    {
      id: "deepseek/deepseek-chat-v3-0324",
      displayName: "DeepSeek V3",
      contextWindowTokens: 163_840,
      defaultContextWindowTokens: 163_840,
      maxOutputTokens: 32_000,
    },
    {
      id: "deepseek/deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 384_000,
      supportsThinking: true,
    },
    {
      id: "deepseek/deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 384_000,
      supportsThinking: true,
    },
    {
      id: "deepseek/deepseek-v3.2-speciale",
      displayName: "DeepSeek V3.2 Speciale",
      contextWindowTokens: 163_840,
      defaultContextWindowTokens: 163_840,
      maxOutputTokens: 163_840,
      supportsThinking: true,
    },
    {
      id: "qwen/qwen3.5-plus-02-15",
      displayName: "Qwen 3.5 Plus",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
      supportsThinking: true,
    },
    {
      id: "qwen/qwen3.5-397b-a17b",
      displayName: "Qwen 3.5 397B",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
      supportsThinking: true,
    },
    {
      id: "qwen/qwen3.5-flash-02-23",
      displayName: "Qwen 3.5 Flash",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
    },
    {
      id: "qwen/qwen3-coder-next",
      displayName: "Qwen 3 Coder",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
    },
    {
      id: "moonshotai/kimi-k2.6",
      displayName: "Kimi K2.6",
      contextWindowTokens: 262_144,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 32_768,
      supportsThinking: true,
    },
    {
      id: "moonshotai/kimi-k2.5",
      displayName: "Kimi K2.5",
      contextWindowTokens: 256_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 32_768,
    },
    {
      id: "minimax/minimax-m3",
      displayName: "MiniMax M3",
      contextWindowTokens: 524_288,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 512_000,
      supportsThinking: true,
    },
    {
      id: "minimax/minimax-m2.7",
      displayName: "MiniMax M2.7",
      contextWindowTokens: 196_608,
      defaultContextWindowTokens: 196_608,
      maxOutputTokens: 131_072,
      supportsThinking: true,
    },
    {
      id: "minimax/minimax-m2.5",
      displayName: "MiniMax M2.5",
      contextWindowTokens: 196_608,
      defaultContextWindowTokens: 196_608,
      maxOutputTokens: 196_608,
      supportsThinking: true,
    },
    {
      id: "minimax/minimax-m2.1",
      displayName: "MiniMax M2.1",
      contextWindowTokens: 196_608,
      defaultContextWindowTokens: 196_608,
      maxOutputTokens: 196_608,
      supportsThinking: true,
    },
    {
      id: "minimax/minimax-m2",
      displayName: "MiniMax M2",
      contextWindowTokens: 196_608,
      defaultContextWindowTokens: 196_608,
      maxOutputTokens: 196_608,
      supportsThinking: true,
    },
    {
      id: "minimax/minimax-m2-her",
      displayName: "MiniMax M2-her",
      contextWindowTokens: 65_536,
      defaultContextWindowTokens: 65_536,
      maxOutputTokens: 2_048,
    },
    {
      id: "minimax/minimax-m1",
      displayName: "MiniMax M1",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 40_000,
      supportsThinking: true,
    },
    {
      id: "minimax/minimax-01",
      displayName: "MiniMax-01",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 1_000_000,
    },
    {
      id: "z-ai/glm-5.2",
      displayName: "GLM-5.2",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
    },
    {
      id: "mistralai/mistral-medium-3",
      displayName: "Mistral Medium 3",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 16_000,
    },
    {
      id: "mistralai/mistral-small-2603",
      displayName: "Mistral Small 4",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 16_000,
    },
    {
      id: "mistralai/devstral-2512",
      displayName: "Devstral 2",
      contextWindowTokens: 131_072,
      defaultContextWindowTokens: 131_072,
      maxOutputTokens: 16_000,
    },
    {
      id: "meta-llama/llama-4-maverick",
      displayName: "Llama 4 Maverick",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
    },
    {
      id: "meta-llama/llama-4-scout",
      displayName: "Llama 4 Scout",
      contextWindowTokens: 327_680,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
    },
    {
      id: "amazon/nova-pro-v1",
      displayName: "Amazon Nova Pro",
      contextWindowTokens: 300_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 5_000,
    },
    {
      id: "openrouter/owl-alpha",
      displayName: "Owl Alpha",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 262_144,
    },
  ],
  "vercel-ai-gateway": [
    {
      id: "anthropic/claude-fable-5",
      displayName: "Claude Fable 5",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      adaptiveThinkingOnly: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-opus-4.8",
      displayName: "Claude Opus 4.8",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-opus-4.6",
      displayName: "Claude Opus 4.6",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-sonnet-4.6",
      displayName: "Claude Sonnet 4.6",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 200_000,
    },
    {
      id: "anthropic/claude-haiku-4.5",
      displayName: "Claude Haiku 4.5",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
    },
    {
      id: "openai/gpt-5.5",
      displayName: "GPT-5.5",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "openai/gpt-5.5-pro",
      displayName: "GPT-5.5 Pro",
      contextWindowTokens: 1_050_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      longContextPricingThresholdTokens: 272_000,
    },
    {
      id: "xai/grok-4.3",
      displayName: "Grok 4.3",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
      supportsThinking: true,
    },
    {
      id: "moonshotai/kimi-k2.6",
      displayName: "Kimi K2.6",
      contextWindowTokens: 262_144,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 32_768,
      supportsThinking: true,
    },
    {
      id: "deepseek/deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindowTokens: 1_048_576,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 384_000,
      supportsThinking: true,
    },
  ],
  minimax: [
    {
      id: "MiniMax-M3",
      displayName: "MiniMax M3",
      contextWindowTokens: 1_000_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 512_000,
      supportsThinking: true,
    },
    {
      id: "MiniMax-M2.7",
      displayName: "MiniMax M2.7",
      contextWindowTokens: 200_000,
      defaultContextWindowTokens: 200_000,
      maxOutputTokens: 16_384,
      supportsThinking: true,
    },
  ],
  atlascloud: [
    {
      id: "deepseek-ai/deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindowTokens: 128_000,
      defaultContextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
      supportsThinking: true,
    },
  ],
  "openai-compatible": [],
} as const satisfies Record<string, readonly LlmCatalogModel[]>;

export type LlmProviderId = keyof typeof MODELS_BY_PROVIDER;

export const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProviderId, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  gemini: "gemini-2.5-flash",
  ollama: "llama3.2",
  fireworks: "accounts/fireworks/models/kimi-k2p5",
  together: "MiniMaxAI/MiniMax-M3",
  openrouter: "x-ai/grok-4.20",
  "vercel-ai-gateway": "anthropic/claude-sonnet-4.6",
  minimax: "MiniMax-M2.7",
  atlascloud: "deepseek-ai/deepseek-v4-pro",
  "openai-compatible": "",
};

/**
 * Provider id → human-readable label. Covers every provider in the
 * daemon catalog. Consumers should fall back to the raw id on miss:
 *   PROVIDER_DISPLAY_NAMES[id] ?? id
 */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  // Not catalog providers: the platform-managed routing sentinel and the
  // subscription-auth pseudo-provider. Cards and pickers render both as
  // providers, so they need display names.
  vellum: "Vellum",
  chatgpt: "ChatGPT Subscription",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama",
  fireworks: "Fireworks",
  together: "Together AI",
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "openai-compatible": "OpenAI-compatible",
  minimax: "MiniMax",
  atlascloud: "Atlas Cloud",
};

/**
 * Whether each provider supports Vellum-managed (`platform`) auth.
 * Covers every provider in the daemon catalog so the connection
 * editor can filter the auth-type dropdown for providers like
 * Fireworks and OpenRouter that have no managed proxy route.
 * Missing entries are treated as `false`.
 */
export const PROVIDER_SUPPORTS_PLATFORM_AUTH: Record<string, boolean> = {
  anthropic: true,
  openai: true,
  gemini: true,
  ollama: false,
  fireworks: true,
  together: true,
  openrouter: false,
  "vercel-ai-gateway": false,
  "openai-compatible": false,
  minimax: false,
  atlascloud: false,
};

export const MANAGED_MODELS = MODELS_BY_PROVIDER.anthropic;

/**
 * Providers the Vellum-managed entry can route to. Single source of truth for
 * the web (the settings-domain MANAGED_ROUTABLE_PROVIDERS set derives from
 * it); mirrors the daemon's managed-routable set in
 * assistant/src/providers/platform-proxy/constants.ts.
 */
export const VELLUM_SERVED_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "fireworks",
  "together",
] as const;

/**
 * The Vellum entry's model list: the union of the managed-routable providers'
 * catalogs, deduplicated by id in VELLUM_SERVED_PROVIDERS order. Users pick
 * "Vellum" + a model; which upstream serves it is an implementation detail.
 */
const VELLUM_MODELS: readonly LlmCatalogModel[] = (() => {
  const seen = new Set<string>();
  const union: LlmCatalogModel[] = [];
  for (const provider of VELLUM_SERVED_PROVIDERS) {
    for (const model of MODELS_BY_PROVIDER[provider]) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        union.push(model);
      }
    }
  }
  return union;
})();

/**
 * The managed upstream that serves a model picked under the Vellum entry —
 * the first VELLUM_SERVED_PROVIDERS member whose catalog lists the id. Used
 * at profile-save time to derive the wire-shape provider for
 * provider_connection: "vellum" profiles.
 */
export function getManagedUpstreamForModel(
  modelId: string,
): (typeof VELLUM_SERVED_PROVIDERS)[number] | undefined {
  // `<provider>/<model>` Vellum routing strings name their upstream directly
  // (mirrors the daemon's parseVellumModel).
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const prefix = modelId.slice(0, slash);
    const match = VELLUM_SERVED_PROVIDERS.find((p) => p === prefix);
    if (match) {
      return match;
    }
  }
  return VELLUM_SERVED_PROVIDERS.find((provider) =>
    MODELS_BY_PROVIDER[provider].some((m) => m.id === modelId),
  );
}

export function getModelsForProvider(
  provider: string,
): readonly LlmCatalogModel[] {
  if (provider === "vellum") {
    return VELLUM_MODELS;
  }
  return MODELS_BY_PROVIDER[provider as LlmProviderId] ?? [];
}

export function getDefaultModelForProvider(
  provider: string,
): string | undefined {
  return DEFAULT_MODEL_BY_PROVIDER[provider as LlmProviderId];
}

export function providerSupportsPlatformAuth(provider: string): boolean {
  return PROVIDER_SUPPORTS_PLATFORM_AUTH[provider] === true;
}
