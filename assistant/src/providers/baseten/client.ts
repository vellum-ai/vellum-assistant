import {
  type ApiKeyValidationResult,
  validateOpenAICompatibleApiKey,
} from "../openai/api-key-validation.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface BasetenProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

/** Baseten Model APIs expose a single OpenAI-compatible serverless endpoint. */
const DEFAULT_BASETEN_BASE_URL = "https://inference.baseten.co/v1";

export async function validateBasetenApiKey(
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  return validateOpenAICompatibleApiKey({
    apiKey,
    baseURL: DEFAULT_BASETEN_BASE_URL,
    providerLabel: "Baseten",
  });
}

export class BasetenProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: BasetenProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_BASETEN_BASE_URL,
      providerName: "baseten",
      providerLabel: "Baseten",
      streamTimeoutMs: options.streamTimeoutMs,
      // Baseten hosts reasoning models (e.g. Inkling) that emit chain of
      // thought via `reasoning_content` rather than inline `<think>` tags. The
      // base provider parses this field into thinking blocks and replays it on
      // multi-turn requests.
      assistantReasoningField: "reasoning_content",
    });
  }
}
