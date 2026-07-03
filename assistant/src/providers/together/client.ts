import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface TogetherProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_TOGETHER_BASE_URL = "https://api.together.ai/v1";

/**
 * Together AI exposes an OpenAI-compatible endpoint. Used as the managed route
 * for MiniMax M3. Together serializes object-typed tool args correctly, so —
 * unlike {@link FireworksProvider} — no `coerceObjectArgsToJsonString`
 * workaround is needed.
 */
export class TogetherProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: TogetherProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_TOGETHER_BASE_URL,
      providerName: "together",
      providerLabel: "Together AI",
      streamTimeoutMs: options.streamTimeoutMs,
      // MiniMax M3 is a reasoning model; Together emits chain-of-thought via
      // `reasoning_content`, which the base provider parses into thinking
      // blocks and replays on multi-turn requests.
      assistantReasoningField: "reasoning_content",
      maxReasoningEffort: "high",
    });
  }
}
