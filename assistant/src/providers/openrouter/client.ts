import { OpenAIProvider } from "../openai/client.js";

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
      extraCreateParams: { reasoning: { enabled: true } },
    });
  }
}
