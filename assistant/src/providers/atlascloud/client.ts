import {
  type ApiKeyValidationResult,
  validateOpenAICompatibleApiKey,
} from "../openai/api-key-validation.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface AtlasCloudProviderOptions {
  apiKey?: string;
  streamTimeoutMs?: number;
}

/**
 * Atlas Cloud exposes a single OpenAI-compatible endpoint. Unlike MiniMax it
 * has no regional fallback host, so validation targets this URL only.
 */
const DEFAULT_ATLASCLOUD_BASE_URL = "https://api.atlascloud.ai/v1";

export async function validateAtlasCloudApiKey(
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  return validateOpenAICompatibleApiKey({
    apiKey,
    baseURL: DEFAULT_ATLASCLOUD_BASE_URL,
    providerLabel: "Atlas Cloud",
  });
}

export class AtlasCloudProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: AtlasCloudProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: DEFAULT_ATLASCLOUD_BASE_URL,
      providerName: "atlascloud",
      providerLabel: "Atlas Cloud",
      streamTimeoutMs: options.streamTimeoutMs,
      // Atlas Cloud hosts reasoning models (e.g. DeepSeek) that emit chain of
      // thought via `reasoning_content` rather than inline `<think>` tags. The
      // base provider parses this field into thinking blocks and replays it on
      // multi-turn requests.
      assistantReasoningField: "reasoning_content",
    });
  }
}
