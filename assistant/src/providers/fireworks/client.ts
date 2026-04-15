import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface FireworksProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export class FireworksProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: FireworksProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_FIREWORKS_BASE_URL,
      providerName: "fireworks",
      providerLabel: "Fireworks",
      streamTimeoutMs: options.streamTimeoutMs,
    });
  }
}
