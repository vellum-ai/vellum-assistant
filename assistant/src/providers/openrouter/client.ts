import { OpenAIProvider } from "../openai/client.js";
import type { SendMessageOptions } from "../types.js";

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends OpenAIProvider {
  constructor(
    apiKey: string,
    model: string,
    options: OpenRouterProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_OPENROUTER_BASE_URL,
      providerName: "openrouter",
      providerLabel: "OpenRouter",
      streamTimeoutMs: options.streamTimeoutMs,
    });
  }

  // OpenRouter's unified `reasoning` parameter controls extended thinking
  // across upstream providers (e.g. it maps to Anthropic's `thinking`
  // parameter for Claude models). Mirror the assistant's `thinking.enabled`
  // config — loop.ts only sets `config.thinking` when enabled — so users can
  // turn thinking off on Anthropic models served via OpenRouter.
  protected override buildExtraCreateParams(
    options?: SendMessageOptions,
  ): Record<string, unknown> {
    const config = options?.config as Record<string, unknown> | undefined;
    const thinkingEnabled = config?.thinking !== undefined;
    return { reasoning: { enabled: thinkingEnabled } };
  }
}
