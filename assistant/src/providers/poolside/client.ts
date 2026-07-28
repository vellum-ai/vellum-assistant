import {
  type ApiKeyValidationResult,
  validateOpenAICompatibleApiKey,
} from "../openai/api-key-validation.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface PoolsideProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

/** Poolside exposes a single OpenAI-compatible inference endpoint. */
const DEFAULT_POOLSIDE_BASE_URL = "https://inference.poolside.ai";

export async function validatePoolsideApiKey(
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  return validateOpenAICompatibleApiKey({
    apiKey,
    baseURL: DEFAULT_POOLSIDE_BASE_URL,
    providerLabel: "Poolside",
  });
}

export class PoolsideProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: PoolsideProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_POOLSIDE_BASE_URL,
      providerName: "poolside",
      providerLabel: "Poolside",
      streamTimeoutMs: options.streamTimeoutMs,
      // Poolside's Laguna models emit chain of thought via `reasoning_content`
      // rather than inline `<think>` tags. The base provider parses this field
      // into thinking blocks and replays it on multi-turn requests.
      assistantReasoningField: "reasoning_content",
    });
  }
}
